//! Parse private dotenv files without reading or mutating the process environment.
use super::{EnvType, EnvVariable, LIMIT, Manifest, environment_path};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{collections::BTreeMap, fs, io::Read, path::Path};

pub(crate) fn environment(dir: &Path, manifest: &Manifest) -> Result<BTreeMap<String, String>> {
    let bytes = read_environment(&environment_path(dir, &manifest.id)?)?;
    parse_environment(manifest, &bytes)
}

pub(super) fn read_environment(path: &Path) -> Result<Vec<u8>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("could not read plugin .env"),
    };
    ensure!(metadata.is_file(), "plugin .env must be a regular file");
    let file = fs::File::open(path).context("could not read plugin .env")?;
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= LIMIT, "plugin .env exceeds 4 MiB");
    Ok(bytes)
}

pub(super) fn parse_environment(
    manifest: &Manifest,
    bytes: &[u8],
) -> Result<BTreeMap<String, String>> {
    validate_environment_schema(manifest)?;
    let source =
        std::str::from_utf8(bytes).map_err(|_| anyhow::anyhow!("plugin .env must be UTF-8"))?;
    // The dependency's unquoted fallback accepts an unmatched leading quote.
    // Require quoted assignments to close before a comment or end of line.
    for line in source.lines().map(str::trim_start) {
        if line.starts_with('#') {
            continue;
        }
        if let Some((_, value)) = line.split_once('=') {
            let value = value.trim_start();
            if let Some(quote @ (b'\'' | b'"')) = value.as_bytes().first().copied() {
                let (_, trailing) = value[1..]
                    .split_once(quote as char)
                    .context("invalid plugin .env syntax")?;
                let trailing = trailing.trim_start();
                ensure!(
                    trailing.is_empty() || trailing.starts_with('#'),
                    "invalid plugin .env syntax"
                );
            }
        }
    }
    // This parser deliberately performs no variable substitution or host-env lookup.
    // Parser errors can contain the offending line, so do not expose their text.
    let overrides = dotenv_parser::parse_dotenv(source)
        .map_err(|_| anyhow::anyhow!("invalid plugin .env syntax"))?;
    let mut values = BTreeMap::new();
    for (key, variable) in &manifest.env {
        if let Some(default) = &variable.default {
            let text = match default {
                Value::String(text) => text.clone(),
                _ => default.to_string(),
            };
            values.insert(key.clone(), text);
        }
    }
    for (key, value) in overrides {
        ensure!(
            manifest.env.contains_key(&key),
            "undeclared plugin environment variable"
        );
        values.insert(key, value);
    }
    for (key, variable) in &manifest.env {
        match values.get(key) {
            Some(value) => {
                ensure!(!value.contains('\0'), "invalid environment variable: {key}");
                ensure!(
                    !variable.required || !value.is_empty(),
                    "missing environment variable: {key}"
                );
                validate_value(variable, value)
                    .with_context(|| format!("invalid environment variable: {key}"))?;
            }
            None => ensure!(!variable.required, "missing environment variable: {key}"),
        }
    }
    Ok(values)
}

fn validate_value(variable: &EnvVariable, value: &str) -> Result<()> {
    let scalar = match variable.kind {
        EnvType::String => {
            ensure!(
                variable.choices.as_ref().is_none_or(|choices| choices
                    .iter()
                    .any(|choice| choice.as_str() == Some(value))),
                "invalid enum choice"
            );
            return Ok(());
        }
        EnvType::Integer => {
            if let Ok(number) = value.parse::<i64>() {
                Value::from(number)
            } else {
                value
                    .parse::<u64>()
                    .map(Value::from)
                    .map_err(|_| anyhow::anyhow!("expected integer"))?
            }
        }
        EnvType::Number => {
            let number: Value = serde_json::from_str(value)
                .map_err(|_| anyhow::anyhow!("expected finite number"))?;
            ensure!(number.is_number(), "expected finite number");
            number
        }
        EnvType::Boolean => match value {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => anyhow::bail!("expected true or false"),
        },
    };
    validate_scalar(variable, &scalar)
}

fn validate_scalar(variable: &EnvVariable, value: &Value) -> Result<()> {
    ensure!(
        match variable.kind {
            EnvType::String => value.is_string(),
            EnvType::Integer => value.is_i64() || value.is_u64(),
            EnvType::Number => value.is_number(),
            EnvType::Boolean => value.is_boolean(),
        },
        "invalid scalar type"
    );
    if let Some(choices) = &variable.choices {
        ensure!(choices.contains(value), "invalid enum choice");
    }
    Ok(())
}

pub(super) fn validate_environment_schema(manifest: &Manifest) -> Result<()> {
    ensure!(manifest.env.len() <= 256, "too many environment variables");
    for (key, variable) in &manifest.env {
        ensure!(
            !key.is_empty()
                && key.len() <= 128
                && key.bytes().enumerate().all(|(index, c)| {
                    c.is_ascii_uppercase() || c == b'_' || (index > 0 && c.is_ascii_digit())
                }),
            "environment names must be uppercase identifiers"
        );
        ensure!(
            !["PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING"].contains(&key.as_str()),
            "environment variable is reserved by the runtime: {key}"
        );
        ensure!(
            !variable.secret || variable.default.is_none(),
            "secret environment variables cannot have defaults: {key}"
        );
        if let Some(choices) = &variable.choices {
            ensure!(
                !choices.is_empty() && choices.len() <= 256,
                "invalid environment enum size: {key}"
            );
            for (index, choice) in choices.iter().enumerate() {
                validate_scalar(variable, choice)
                    .with_context(|| format!("invalid environment enum: {key}"))?;
                ensure!(
                    !choices[..index].contains(choice),
                    "repeated environment enum choice: {key}"
                );
            }
        }
        if let Some(default) = &variable.default {
            validate_scalar(variable, default)
                .with_context(|| format!("invalid environment default: {key}"))?;
            ensure!(
                !default.as_str().is_some_and(|text| text.contains('\0')),
                "invalid environment default: {key}"
            );
            ensure!(
                !variable.required || default.as_str() != Some(""),
                "empty required environment default: {key}"
            );
        }
    }
    Ok(())
}

pub(crate) fn validate_binding(dir: &Path, values: &BTreeMap<String, String>) -> Result<()> {
    if let Some(alias) = values.get("OSS_ALIAS") {
        let bucket = values
            .get("BUCKET")
            .context("BUCKET is required with OSS_ALIAS")?;
        let location = format!("oss://{alias}/{bucket}/check");
        crate::storage::oss::Location::parse(&location)
            .map_err(|_| anyhow::anyhow!("invalid plugin OSS binding"))?;
        let store = crate::storage::oss::list(dir)?
            .into_iter()
            .find(|store| store.alias == *alias)
            .context("configured OSS alias does not exist on this Server")?;
        ensure!(
            store.bucket.as_deref().is_none_or(|bound| bound == bucket),
            "bucket differs from OSS alias binding"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Manifest {
        toml::from_str(
            r#"
id = "demo"
name = "Demo"
version = "1.0.0"
authors = [{name = "Team"}]
files = ["demo"]
schemes = ["demo"]
entrypoint = ["./demo"]
[env.API_ORIGIN]
default = "https://example.test"
[env.TOKEN]
required = true
secret = true
[env.COUNT]
type = "integer"
default = 3
[env.DEBUG]
type = "boolean"
default = false
[env.RATE]
type = "number"
default = 0.5
enum = [0.5, 1.5]
[env.MODE]
enum = ["fast", "safe"]
default = "safe"
"#,
        )
        .unwrap()
    }
    #[test]
    fn dotenv_overrides_defaults_without_expansion_or_process_mutation() {
        let manifest = manifest();
        let before = std::env::vars_os().collect::<BTreeMap<_, _>>();
        let values = parse_environment(
            &manifest,
            b"export TOKEN='private $PATH' # comment\nCOUNT=5\nDEBUG=true\nRATE=1.5\n",
        )
        .unwrap();
        assert_eq!(values["TOKEN"], "private $PATH");
        assert_eq!(values["COUNT"], "5");
        assert_eq!(values["API_ORIGIN"], "https://example.test");
        assert_eq!(values["RATE"], "1.5");
        assert_eq!(std::env::vars_os().collect::<BTreeMap<_, _>>(), before);
        assert!(parse_environment(&manifest, b"").is_err());
        if std::env::var_os("HOME").is_some() {
            let mut declared_home = manifest.clone();
            let mut required = declared_home.env["TOKEN"].clone();
            required.secret = false;
            declared_home.env.insert("HOME".into(), required);
            assert!(parse_environment(&declared_home, b"TOKEN=private\n").is_err());
        }
    }
    #[test]
    fn invalid_environment_and_secret_defaults_are_redacted() {
        let mut manifest = manifest();
        for input in [
            "TOKEN=private\nCOUNT=leaked-secret",
            "TOKEN=private\nMODE=leaked-secret",
            "TOKEN=private\nUNKNOWN=leaked-secret",
            "TOKEN='leaked-secret",
            "TOKEN=\"leaked-secret",
            "TOKEN='private'leaked-secret",
            "TOKEN=\"private\"leaked-secret",
            "TOKEN=private\nDEBUG=leaked-secret",
            "TOKEN=private\nRATE=leaked-secret",
            "TOKEN=private\nRATE=NaN",
            "TOKEN=private\nRATE=2.5",
        ] {
            let error = parse_environment(&manifest, input.as_bytes()).unwrap_err();
            assert!(!format!("{error:#}").contains("leaked-secret"));
        }
        manifest.env.get_mut("TOKEN").unwrap().default = Some(Value::String("private".into()));
        assert!(validate_environment_schema(&manifest).is_err());
        manifest.env.get_mut("TOKEN").unwrap().default = None;
        manifest
            .env
            .insert("lowercase".into(), manifest.env["MODE"].clone());
        assert!(validate_environment_schema(&manifest).is_err());
    }
}
