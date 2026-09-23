//! Full-scene PNG rendering through the same Viewer and component readiness contract.
//! A private headless browser is short-lived and never attaches to a user's session.
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
/// Export can read only this scene and its embedded Viewer assets. Re-evaluate
/// every paused request, including redirects; origin equality alone would expose
/// unrelated local administration endpoints to untrusted HTML.
struct ExportRequests {
    document: url::Url,
    base: String,
    scene: String,
    scene_id: Option<String>,
}
impl ExportRequests {
    fn new(document: &str) -> Result<Self> {
        let document = url::Url::parse(document)?;
        let scene_id = document
            .query_pairs()
            .find(|(key, _)| key == "scene")
            .map(|(_, value)| value.into_owned());
        let valid_query = document.query_pairs().all(|(key, value)| {
            (key == "render" && value == "1")
                || (key == "scene" && scene_id.as_deref() == Some(value.as_ref()))
        }) && document
            .query_pairs()
            .filter(|(key, _)| key == "render")
            .count()
            == 1
            && document
                .query_pairs()
                .filter(|(key, _)| key == "scene")
                .count()
                <= 1
            && scene_id.as_ref().is_none_or(|id| {
                !id.is_empty()
                    && id.len() <= 64
                    && id.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_')
                    })
            });
        ensure!(
            document.scheme() == "http"
                && match document.host() {
                    Some(url::Host::Ipv4(ip)) => !ip.is_unspecified(),
                    Some(url::Host::Ipv6(ip)) => !ip.is_unspecified(),
                    _ => false,
                }
                && document.username().is_empty()
                && document.password().is_none()
                && valid_query
                && document.fragment().is_none(),
            "invalid internal export URL"
        );
        let (base, token) = document
            .path()
            .rsplit_once("/s/")
            .context("invalid export scene")?;
        ensure!(
            !token.is_empty() && !token.contains('/') && !token.contains('%'),
            "invalid export token"
        );
        let scene = format!("{base}/api/v1/scenes/{token}");
        let base = base.to_owned();
        Ok(Self {
            document,
            base,
            scene,
            scene_id,
        })
    }
    fn allows(&self, method: &str, address: &str) -> bool {
        if !matches!(method, "GET" | "HEAD") {
            return false;
        }
        let Ok(mut url) = url::Url::parse(address) else {
            return false;
        };
        if url.origin() != self.document.origin()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return false;
        }
        url.set_fragment(None);
        let permitted_scene_query = |allow_embed: bool| {
            let mut scene_seen = false;
            let mut embed_seen = false;
            for (key, value) in url.query_pairs() {
                if key == "scene" && self.scene_id.as_deref() == Some(value.as_ref()) && !scene_seen
                {
                    scene_seen = true;
                } else if allow_embed && key == "embed" && value == "1" && !embed_seen {
                    embed_seen = true;
                } else {
                    return false;
                }
            }
            scene_seen == self.scene_id.is_some() && (!allow_embed || embed_seen)
        };
        if method == "HEAD" {
            return permitted_scene_query(true)
                && url
                    .path()
                    .strip_prefix(&format!("{}/attachments/", self.scene))
                    .is_some_and(|index| {
                        !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit())
                    });
        }
        if url == self.document {
            return true;
        }
        let path = url.path();
        if path.contains('%') || path.contains('\\') {
            return false;
        }
        if let Some(asset) = path.strip_prefix(&format!("{}/assets/", self.base)) {
            return url.query().is_none()
                && !asset.is_empty()
                && !asset.contains('/')
                && asset
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                && [".js", ".css", ".woff2", ".svg", ".png"]
                    .iter()
                    .any(|ext| asset.ends_with(ext));
        }
        if path == self.scene {
            return permitted_scene_query(false);
        }
        let Some(tail) = path.strip_prefix(&format!("{}/", self.scene)) else {
            return false;
        };
        let parts: Vec<_> = tail.split('/').collect();
        let index = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        match parts.as_slice() {
            ["meshes", n] | ["meshes", n, "lod"] => index(n) && permitted_scene_query(false),
            ["attachments", n] => {
                index(n) && (permitted_scene_query(false) || permitted_scene_query(true))
            }
            ["renderers", id] => {
                !id.is_empty()
                    && id.len() <= 128
                    && id.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_')
                    })
                    && permitted_scene_query(false)
            }
            _ => false,
        }
    }
}
struct Cdp {
    socket: Socket,
    sequence: u64,
    session: Option<String>,
    requests: ExportRequests,
    // Side-command replies are checked without recursively awaiting them: a
    // Page.navigate response may itself be waiting for Fetch.continueRequest.
    pending: HashMap<u64, Option<String>>,
    initializing: HashMap<String, usize>,
}
fn auto_attach() -> Value {
    json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,
        "filter":[{"type":"iframe","exclude":false},{"exclude":true}]})
}
impl Cdp {
    async fn send(&mut self, method: &str, params: Value, session: Option<&str>) -> Result<u64> {
        self.sequence += 1;
        let mut message = json!({"id":self.sequence,"method":method,"params":params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(message.to_string().into()))
            .await?;
        Ok(self.sequence)
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let session = self.session.clone();
        let wanted = self.send(method, params, session.as_deref()).await?;
        while let Some(message) = self.socket.next().await {
            let message = message?;
            if !message.is_text() {
                continue;
            }
            let value: Value = serde_json::from_str(message.to_text()?)?;
            if let Some(id) = value["id"].as_u64() {
                if id == wanted {
                    ensure!(
                        value.get("error").is_none(),
                        "browser protocol failed: {method}"
                    );
                    return Ok(value["result"].clone());
                }
                if let Some(initializing) = self.pending.remove(&id) {
                    ensure!(
                        value.get("error").is_none(),
                        "browser request isolation failed"
                    );
                    if let Some(session) = initializing {
                        let remaining = self
                            .initializing
                            .get_mut(&session)
                            .context("missing frame initialization")?;
                        *remaining -= 1;
                        if *remaining == 0 {
                            self.initializing.remove(&session);
                            let id = self
                                .send("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
                                .await?;
                            self.pending.insert(id, None);
                        }
                    }
                }
                continue;
            }
            let params = &value["params"];
            match value["method"].as_str() {
                Some("Fetch.requestPaused") => {
                    let session = value["sessionId"]
                        .as_str()
                        .context("missing intercepted session")?;
                    let allowed = self.requests.allows(
                        params["request"]["method"].as_str().unwrap_or(""),
                        params["request"]["url"].as_str().unwrap_or(""),
                    );
                    let (method, arguments) = if allowed {
                        (
                            "Fetch.continueRequest",
                            json!({"requestId":params["requestId"]}),
                        )
                    } else {
                        (
                            "Fetch.failRequest",
                            json!({"requestId":params["requestId"],"errorReason":"BlockedByClient"}),
                        )
                    };
                    let id = self.send(method, arguments, Some(session)).await?;
                    self.pending.insert(id, None);
                }
                Some("Target.attachedToTarget") if params["targetInfo"]["type"] == "iframe" => {
                    // Cross-origin/opaque iframe renderers may live in separate
                    // processes. Pause them until interception is installed too.
                    let session = params["sessionId"]
                        .as_str()
                        .context("missing child frame session")?
                        .to_owned();
                    self.initializing.insert(session.clone(), 2);
                    for (method, args) in [
                        (
                            "Fetch.enable",
                            json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
                        ),
                        ("Target.setAutoAttach", auto_attach()),
                    ] {
                        let id = self.send(method, args, Some(&session)).await?;
                        self.pending.insert(id, Some(session.clone()));
                    }
                }
                _ => {}
            }
        }
        bail!("render browser disconnected")
    }
}
fn executable() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("BLIND_RENDER_BROWSER") {
        return Ok(path.into());
    }
    for path in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ] {
        if std::path::Path::new(path).is_file() {
            return Ok(path.into());
        }
    }
    bail!("Component image export requires Chromium; configure BLIND_RENDER_BROWSER")
}
pub async fn render(url: &str, width: u32, height: u32) -> Result<Vec<u8>> {
    let requests = ExportRequests::new(url)?;
    let profile = tempfile::tempdir()?;
    let mut child = tokio::process::Command::new(executable()?)
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-dev-shm-usage",
            "--enable-unsafe-swiftshader",
            "--hide-scrollbars",
        ])
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("could not start render browser")?;
    let operation = async {
        let endpoint = loop {
            if let Ok(text) =
                tokio::fs::read_to_string(profile.path().join("DevToolsActivePort")).await
            {
                let mut lines = text.lines();
                if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                    break format!("ws://127.0.0.1:{port}{path}");
                }
            }
            ensure!(
                child.try_wait()?.is_none(),
                "render browser exited before startup"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let (socket, _) = tokio_tungstenite::connect_async(&endpoint).await?;
        let mut cdp = Cdp {
            socket,
            sequence: 0,
            session: None,
            requests,
            pending: HashMap::new(),
            initializing: HashMap::new(),
        };
        let target = cdp
            .call("Target.createTarget", json!({"url":"about:blank"}))
            .await?;
        let session = cdp
            .call(
                "Target.attachToTarget",
                json!({"targetId":target["targetId"],"flatten":true}),
            )
            .await?;
        cdp.session = Some(
            session["sessionId"]
                .as_str()
                .context("missing render session")?
                .into(),
        );
        cdp.call(
            "Fetch.enable",
            json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
        )
        .await?;
        cdp.call("Target.setAutoAttach", auto_attach()).await?;
        cdp.call("Page.enable", json!({})).await?;
        cdp.call("Emulation.setDeviceMetricsOverride",json!({"width":width.clamp(240,4096),"height":height.clamp(240,4096),"deviceScaleFactor":1,"mobile":false})).await?;
        cdp.call("Page.navigate", json!({"url":url})).await?;
        loop {
            let value = cdp.call("Runtime.evaluate",json!({"expression":"({status:document.documentElement.dataset.renderStatus,error:document.documentElement.dataset.renderError})","returnByValue":true})).await?;
            let value = &value["result"]["value"];
            if value["status"] == "ready" {
                break;
            }
            if value["status"] == "error" {
                bail!(
                    "component render failed: {}",
                    value["error"].as_str().unwrap_or("unknown")
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let capture = cdp
            .call(
                "Page.captureScreenshot",
                json!({"format":"png","fromSurface":true,"captureBeyondViewport":false}),
            )
            .await?;
        Ok::<_, anyhow::Error>(
            base64::engine::general_purpose::STANDARD
                .decode(capture["data"].as_str().context("missing PNG")?)?,
        )
    };
    let result = tokio::time::timeout(Duration::from_secs(75), operation)
        .await
        .context("scene export timed out")
        .and_then(|result| result);
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_requests_are_bound_to_one_scene_and_read_only_assets() {
        let policy = ExportRequests::new("http://127.0.0.1:7418/blind/s/abc_12?render=1").unwrap();
        for tail in [
            "/s/abc_12?render=1",
            "/assets/index-abc.js",
            "/assets/index-abc.css",
            "/api/v1/scenes/abc_12",
            "/api/v1/scenes/abc_12/meshes/0",
            "/api/v1/scenes/abc_12/meshes/0/lod",
            "/api/v1/scenes/abc_12/attachments/2?embed=1",
            "/api/v1/scenes/abc_12/renderers/resource-1",
        ] {
            assert!(
                policy.allows("GET", &format!("http://127.0.0.1:7418/blind{tail}")),
                "{tail}"
            );
        }
        for address in [
            "https://internal.example/private.png",
            "http://127.0.0.1:7419/blind/api/v1/scenes/abc_12",
            "http://localhost:7418/blind/api/v1/scenes/abc_12",
            "http://user@127.0.0.1:7418/blind/api/v1/scenes/abc_12",
            "http://127.0.0.1:7418/blind/api/v1/scenes/other",
            "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12/share",
            "http://127.0.0.1:7418/blind/api/v1/control/doctor",
            "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12/attachments/0?embed=1&other=1",
            "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12/renderers/%2e%2e",
            "http://127.0.0.1:7418/blind/assets/../../api/v1/hosts",
            "http://127.0.0.1:7418/assets/index-abc.js",
            "file:///etc/passwd",
            "data:text/html,test",
        ] {
            assert!(!policy.allows("GET", address), "{address}");
        }
        assert!(policy.allows(
            "GET",
            &format!(
                "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12/renderers/plugin-{}",
                "a".repeat(64)
            )
        ));
        assert!(policy.allows(
            "HEAD",
            "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12/attachments/0?embed=1"
        ));
        assert!(!policy.allows("HEAD", "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12"));
        assert!(!policy.allows(
            "HEAD",
            "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12/attachments/0"
        ));
        assert!(!policy.allows("POST", "http://127.0.0.1:7418/blind/api/v1/scenes/abc_12"));
        assert!(ExportRequests::new("https://example.org/s/token?render=1").is_err());
        for address in ["[::1]", "192.0.2.10"] {
            let policy =
                ExportRequests::new(&format!("http://{address}:7400/s/token?render=1")).unwrap();
            assert!(policy.allows("GET", &format!("http://{address}:7400/api/v1/scenes/token")));
            assert!(!policy.allows("GET", "http://127.0.0.1:7400/api/v1/scenes/token"));
        }
    }
    /// Execute explicitly on a host with Chrome/Chromium. The fake Viewer has a
    /// deliberately permissive CSP so this tests CDP isolation independently.
    #[tokio::test]
    #[ignore = "requires Chrome/Chromium"]
    async fn chromium_blocks_frame_requests_and_redirects() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sink = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let external = format!("http://{}", sink.local_addr().unwrap());
        let escaped = Arc::new(AtomicUsize::new(0));
        let redirected = Arc::new(AtomicUsize::new(0));
        let external_hits = escaped.clone();
        let sink_task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = sink.accept().await {
                external_hits.fetch_add(1, Ordering::SeqCst);
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
            }
        });
        let local_hits = escaped.clone();
        let redirect_hits = redirected.clone();
        let local_origin = origin.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = vec![0; 8192];
                let size = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let path = request.split_whitespace().nth(1).unwrap_or("");
                let (status, headers, body) = match path {
                    "/s/test?render=1" => ("200 OK", String::new(), r#"<!doctype html><script>
                    let initialized=0; addEventListener('message',e=>{if(e.data==='attempted' && ++initialized===2)setTimeout(()=>document.documentElement.dataset.renderStatus='ready',700)});
                    </script><iframe sandbox="allow-scripts" src="/api/v1/scenes/test/renderers/outer"></iframe>"#.to_owned()),
                    "/api/v1/scenes/test/renderers/outer" => ("200 OK", "Content-Security-Policy: sandbox allow-scripts\r\n".into(), format!(r#"<!doctype html><script>
                    new Image().src='{external}/image'; fetch('{external}/fetch').catch(()=>{{}});
                    new Image().src='{local_origin}/private';
                    new Image().src='{local_origin}/api/v1/scenes/test/attachments/0';
                    parent.postMessage('attempted','*');
                    </script><iframe src="{local_origin}/api/v1/scenes/test/renderers/nested"></iframe>"#)),
                    "/api/v1/scenes/test/renderers/nested" => ("200 OK", "Content-Security-Policy: sandbox allow-scripts\r\n".into(), format!(r#"<!doctype html><script>new Image().src='{external}/nested';parent.parent.postMessage('attempted','*');</script>"#)),
                    "/api/v1/scenes/test/attachments/0" => {
                        redirect_hits.fetch_add(1, Ordering::SeqCst);
                        ("302 Found", format!("Location: {external}/redirected\r\n"), String::new())
                    },
                    _ => { local_hits.fetch_add(1, Ordering::SeqCst); ("404 Not Found", String::new(), String::new()) }
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        let result = render(&format!("{origin}/s/test?render=1"), 400, 300).await;
        server.abort();
        sink_task.abort();
        let png = result.unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        assert_eq!(
            redirected.load(Ordering::SeqCst),
            1,
            "redirect path was not exercised"
        );
        assert_eq!(
            escaped.load(Ordering::SeqCst),
            0,
            "unapproved network request escaped isolation"
        );
    }
}
