//! Server-rendered link metadata. Reads saved descriptors, never source files or renderers.
use super::{NO_STORE, WebAssets, error::AppError, links::request_origin};
use crate::{runtime::config::Config, scene::SceneDescriptor};
use axum::{
    body::Body,
    http::{HeaderMap, Response, StatusCode, header},
};

pub(super) fn origin(headers: &HeaderMap, config: &Config) -> Result<String, AppError> {
    let origin = match &config.preferred_origin {
        Some(origin) => config.normalize_share_origin(origin)?,
        None => {
            // Origin describes the caller, not the page. Use the serving host/proxy instead.
            let mut headers = headers.clone();
            headers.remove(header::ORIGIN);
            request_origin(&headers, config)?
        }
    };
    let url = url::Url::parse(&origin).map_err(anyhow::Error::from)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::internal(
            "preview origin cannot contain credentials",
        ));
    }
    Ok(origin)
}

pub(super) struct Metadata {
    title: String,
    description: String,
    url: String,
    image: Option<String>,
}

impl Metadata {
    pub(super) fn home(origin: &str) -> Self {
        Self {
            title: "Blind".into(),
            description: "在浏览器中查看、比较和分享 3D 模型、文档与图像。".into(),
            url: format!("{origin}/"),
            image: None,
        }
    }

    pub(super) fn scene(
        scene: &SceneDescriptor,
        token: &str,
        origin: &str,
        scene_id: Option<&str>,
    ) -> Self {
        // The persisted collection root also stores its first child.
        let collection = scene.collection.as_ref().filter(|_| scene_id.is_none());
        let title = collection.map_or(scene.title.as_str(), |c| c.title.as_str());
        let first_line = title
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("场景分享");
        let resources: usize = if collection.is_some() {
            scene
                .scene_entries()
                .map(|(_, s)| s.meshes.len() + s.attachments.len())
                .sum()
        } else {
            scene.meshes.len() + scene.attachments.len()
        };
        let summary = if collection.is_some() {
            format!(
                "{} 个场景 · {resources} 个资源 · 在 Blind 中交互查看。",
                scene.scene_entries().count()
            )
        } else {
            format!("{resources} 个资源 · 在 Blind 中交互查看。")
        };
        let details = compact(title, 160);
        let query = scene_id
            .map(|id| {
                format!(
                    "?{}",
                    url::form_urlencoded::Serializer::new(String::new())
                        .append_pair("scene", id)
                        .finish()
                )
            })
            .unwrap_or_default();
        Self {
            title: format!("{} · Blind", compact(first_line, 100)),
            description: if details.is_empty() {
                summary
            } else {
                format!("{summary} {details}")
            },
            url: format!("{origin}/s/{token}{query}"),
            image: Some(format!("{origin}/i/{token}.png{query}")),
        }
    }

    fn head(&self) -> String {
        let title = escape(&self.title);
        let description = escape(&self.description);
        let url = escape(&self.url);
        let mut head = format!(
            "<title>{title}</title>\n<meta name=\"description\" content=\"{description}\">\n\
             <meta property=\"og:site_name\" content=\"Blind\">\n\
             <meta property=\"og:type\" content=\"website\">\n\
             <meta property=\"og:title\" content=\"{title}\">\n\
             <meta property=\"og:description\" content=\"{description}\">\n\
             <meta property=\"og:url\" content=\"{url}\">\n\
             <meta name=\"twitter:title\" content=\"{title}\">\n\
             <meta name=\"twitter:description\" content=\"{description}\">"
        );
        if let Some(image) = &self.image {
            let image = escape(image);
            head.push_str(&format!(
                "\n<meta property=\"og:image\" content=\"{image}\">\n\
                 <meta property=\"og:image:type\" content=\"image/png\">\n\
                 <meta property=\"og:image:alt\" content=\"{title}\">\n\
                 <meta name=\"twitter:card\" content=\"summary_large_image\">\n\
                 <meta name=\"twitter:image\" content=\"{image}\">"
            ));
        } else {
            head.push_str("\n<meta name=\"twitter:card\" content=\"summary\">");
        }
        head
    }
}

// Limit Unicode characters without splitting UTF-8, collapse whitespace and discard controls.
fn compact(value: &str, limit: usize) -> String {
    let clean: String = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let mut chars = clean.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub(super) fn page(
    base_path: Option<String>,
    metadata: Metadata,
) -> Result<Response<Body>, AppError> {
    let asset =
        WebAssets::get("index.html").ok_or_else(|| AppError::not_found("Viewer not built"))?;
    let template = String::from_utf8_lossy(&asset.data);
    if template.matches("<title>Blind</title>").count() != 1 {
        return Err(AppError::internal(
            "viewer metadata placeholder is missing or duplicated",
        ));
    }
    let href = escape(&format!("{}/", base_path.as_deref().unwrap_or_default()));
    let html = template
        .replacen("<title>Blind</title>", &metadata.head(), 1)
        .replacen("<head>", &format!("<head>\n<base href=\"{href}\">"), 1);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, NO_STORE)
        .body(Body::from(html))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_uses_config_or_proxy_never_request_origin() {
        let mut config = Config::fresh();
        config.base_path = Some("/blind".into());
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "https://caller.test".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:7400".parse().unwrap());
        headers.insert("x-forwarded-host", "public.test".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(
            origin(&headers, &config).unwrap(),
            "https://public.test/blind"
        );
        config.preferred_origin = Some("https://canonical.test".into());
        assert_eq!(
            origin(&headers, &config).unwrap(),
            "https://canonical.test/blind"
        );
        config.preferred_origin = Some("https://user:secret@canonical.test".into());
        assert!(origin(&headers, &config).is_err());
    }
}
