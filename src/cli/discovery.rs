//! Expand local directories before assigning resource indices or contacting share endpoints.
use anyhow::{Context, Result, ensure};
use std::{collections::HashSet, fs, path::PathBuf};

const MAX_RESOURCES: usize = 256;

pub(super) fn expand_inputs(
    inputs: Vec<PathBuf>,
    recursive: bool,
    extensions: &[String],
) -> Result<Vec<PathBuf>> {
    let mut directories = Vec::with_capacity(inputs.len());
    for path in &inputs {
        let uri = path.to_string_lossy();
        let is_directory = if crate::plugin::is_plugin(&uri) || crate::storage::oss::is_oss(&uri) {
            false
        } else {
            fs::metadata(path)
                .with_context(|| format!("cannot access {}", path.display()))?
                .is_dir()
        };
        directories.push(is_directory);
    }
    // Preserve explicit resource ordering, duplicates and component overrides.
    if !directories.contains(&true) {
        return Ok(inputs);
    }
    let result = expand(inputs, directories, recursive, extensions)?;
    eprintln!("Sharing {} resources from expanded inputs.", result.len());
    Ok(result)
}

fn supported(path: &std::path::Path, extensions: &[String]) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    crate::scene::component::ComponentKind::infer(&name).is_ok() || {
        let name = name.to_ascii_lowercase();
        extensions
            .iter()
            .any(|ext| name == *ext || name.ends_with(&format!(".{ext}")))
    }
}

fn expand(
    inputs: Vec<PathBuf>,
    directories: Vec<bool>,
    recursive: bool,
    extensions: &[String],
) -> Result<Vec<PathBuf>> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |path: PathBuf, group: &mut Vec<PathBuf>| -> Result<()> {
        let uri = path.to_string_lossy();
        let key = if crate::plugin::is_plugin(&uri) || crate::storage::oss::is_oss(&uri) {
            path.clone()
        } else {
            fs::canonicalize(&path).with_context(|| format!("cannot resolve {}", path.display()))?
        };
        if seen.insert(key) {
            ensure!(
                seen.len() <= MAX_RESOURCES,
                "directory share exceeds {MAX_RESOURCES} resources; select smaller directories or explicit files"
            );
            group.push(path);
        }
        Ok(())
    };
    for (input, is_directory) in inputs.into_iter().zip(directories) {
        if !is_directory {
            add(input, &mut output)?;
            continue;
        }
        let mut pending = vec![input];
        let mut files = Vec::new();
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory)
                .with_context(|| format!("cannot read directory {}", directory.display()))?
            {
                let entry = entry
                    .with_context(|| format!("cannot read entry in {}", directory.display()))?;
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let kind = entry
                    .file_type()
                    .with_context(|| format!("cannot inspect {}", entry.path().display()))?;
                if kind.is_dir() && recursive {
                    pending.push(entry.path());
                } else if kind.is_file() && supported(&entry.path(), extensions) {
                    add(entry.path(), &mut files)?;
                }
            }
        }
        files.sort();
        output.extend(files);
    }
    ensure!(
        !output.is_empty(),
        "no shareable files found in the supplied directories"
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_order_filtering_recursion_and_deduplication() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir(root.join("nested")).unwrap();
        fs::create_dir(root.join(".hidden")).unwrap();
        for name in [
            "z.LOG",
            "a.md",
            "c.TRACEBLOB",
            "skip.bin",
            ".secret.json",
            "nested/b.csv",
            ".hidden/private.txt",
        ] {
            fs::write(root.join(name), "data").unwrap();
        }
        let exts = vec!["traceblob".to_owned()];
        let scan = |recursive| {
            expand(
                vec![root.to_owned(), root.join("a.md"), root.join("nested")],
                vec![true, false, true],
                recursive,
                &exts,
            )
            .unwrap()
        };
        let relative = |files: Vec<PathBuf>| {
            files
                .into_iter()
                .map(|p| p.strip_prefix(root).unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            relative(scan(false)),
            ["a.md", "c.TRACEBLOB", "z.LOG", "nested/b.csv"].map(PathBuf::from)
        );
        assert_eq!(
            relative(scan(true)),
            ["a.md", "c.TRACEBLOB", "nested/b.csv", "z.LOG"].map(PathBuf::from)
        );
        // Explicit unsupported files are retained for --component overrides.
        assert_eq!(
            expand(
                vec![root.join("skip.bin"), root.to_owned()],
                vec![false, true],
                false,
                &exts
            )
            .unwrap()[0],
            root.join("skip.bin")
        );
    }

    #[test]
    fn empty_and_oversized_scans_fail_without_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let scan = || expand(vec![temp.path().to_owned()], vec![true], false, &[]);
        assert!(
            scan()
                .unwrap_err()
                .to_string()
                .contains("no shareable files")
        );
        for i in 0..MAX_RESOURCES {
            fs::write(temp.path().join(format!("{i}.log")), "x").unwrap();
        }
        assert_eq!(scan().unwrap().len(), MAX_RESOURCES);
        fs::write(temp.path().join("overflow.log"), "x").unwrap();
        assert!(scan().unwrap_err().to_string().contains("exceeds 256"));
    }

    #[cfg(unix)]
    #[test]
    fn discovered_symlinks_are_not_followed() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("safe.txt"), "ok").unwrap();
        fs::write(external.path().join("outside.txt"), "outside").unwrap();
        symlink(
            external.path().join("outside.txt"),
            temp.path().join("linked.txt"),
        )
        .unwrap();
        symlink(external.path(), temp.path().join("external")).unwrap();
        symlink(temp.path(), temp.path().join("cycle")).unwrap();
        let files = expand(vec![temp.path().to_owned()], vec![true], true, &[]).unwrap();
        assert_eq!(files, vec![temp.path().join("safe.txt")]);
    }

    #[test]
    fn explicit_inputs_preserve_duplicates_uris_and_missing_path_errors() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("data.bin");
        fs::write(&file, "x").unwrap();
        let inputs = vec![
            file.clone(),
            file,
            PathBuf::from("oss://store/bucket/key"),
            PathBuf::from("example://item"),
        ];
        assert_eq!(expand_inputs(inputs.clone(), false, &[]).unwrap(), inputs);
        assert!(
            expand_inputs(vec![temp.path().join("missing")], true, &[])
                .unwrap_err()
                .to_string()
                .contains("cannot access")
        );
    }
}
