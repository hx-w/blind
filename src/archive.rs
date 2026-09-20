//! Bounded in-memory ZIP member reads. No extraction to the filesystem.
use anyhow::{Context, Result, ensure};
use std::io::{Cursor, Read};
const MAX_MEMBER: u64 = 64 * 1024 * 1024;
pub fn validate_member(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 1024
            && !name.contains('\\')
            && !name.chars().any(char::is_control)
            && name
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "invalid ZIP member path"
    );
    Ok(())
}
pub fn read_member(bytes: &[u8], name: &str) -> Result<Vec<u8>> {
    validate_member(name)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    ensure!(archive.len() <= 4096, "archive has too many members");
    validate_directory_inventory(bytes, &mut archive)?;
    ensure!(
        archive.file_names().filter(|n| *n == name).count() == 1,
        "ZIP member is absent or ambiguous"
    );
    let member = archive.by_name(name).context("ZIP member unavailable")?;
    ensure!(
        !member.is_dir() && !member.is_symlink() && member.size() <= MAX_MEMBER,
        "invalid or oversized ZIP member"
    );
    let mut result = Vec::new();
    member.take(MAX_MEMBER + 1).read_to_end(&mut result)?;
    ensure!(
        result.len() as u64 <= MAX_MEMBER,
        "ZIP member exceeds 64 MiB"
    );
    Ok(result)
}

/// zip 2 indexes the central directory by name, silently replacing duplicates.
/// Check that its surviving entries cover every central header. The library
/// still owns locating the directory (including ZIP64), names and extraction;
/// only the standard header's three variable-length fields are read here.
fn validate_directory_inventory(
    bytes: &[u8],
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
) -> Result<()> {
    let mut headers = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        headers.push(archive.by_index_raw(index)?.central_header_start());
    }
    headers.sort_unstable();
    let mut cursor = archive.central_directory_start();
    for header in headers {
        ensure!(
            header == cursor,
            "ZIP directory has duplicate or unindexed members"
        );
        let start = usize::try_from(cursor)?;
        let fixed = bytes
            .get(
                start
                    ..start
                        .checked_add(46)
                        .context("invalid ZIP directory offset")?,
            )
            .context("truncated ZIP directory header")?;
        ensure!(&fixed[..4] == b"PK\x01\x02", "invalid ZIP directory header");
        let variable: u64 = [28, 30, 32]
            .iter()
            .map(|&offset| u16::from_le_bytes([fixed[offset], fixed[offset + 1]]) as u64)
            .sum();
        cursor = cursor
            .checked_add(46 + variable)
            .context("invalid ZIP directory length")?;
        ensure!(
            cursor <= bytes.len() as u64,
            "truncated ZIP directory member"
        );
    }
    let tail = bytes.get(usize::try_from(cursor)?..).unwrap_or_default();
    ensure!(
        !tail.starts_with(b"PK\x01\x02"),
        "ZIP directory has duplicate or unindexed members"
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn bundle(names: &[&str], zip64: bool) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in names {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default().large_file(zip64),
                )
                .unwrap();
            writer.write_all(b"content").unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_regular_and_zip64_members() {
        for zip64 in [false, true] {
            let bytes = bundle(&["run.log", "other.txt"], zip64);
            assert_eq!(read_member(&bytes, "run.log").unwrap(), b"content");
        }
    }

    #[test]
    fn rejects_duplicate_central_directory_names() {
        let mut bytes = bundle(&["run.log", "alt.log"], false);
        // Equal-length replacement produces two valid entries named run.log;
        // zip 2's public inventory deliberately exposes just the last one.
        for offset in 0..bytes.len() - 6 {
            if &bytes[offset..offset + 7] == b"alt.log" {
                bytes[offset..offset + 7].copy_from_slice(b"run.log");
            }
        }
        let archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(archive.len(), 1);
        assert_eq!(archive.file_names().filter(|n| *n == "run.log").count(), 1);
        assert!(read_member(&bytes, "run.log").is_err());
    }

    #[test]
    fn rejects_oversized_member_inventory() {
        let names: Vec<_> = (0..4097).map(|n| format!("{n:04}.log")).collect();
        let refs: Vec<_> = names.iter().map(String::as_str).collect();
        assert!(read_member(&bundle(&refs, false), "0000.log").is_err());
    }

    #[test]
    fn rejects_traversal() {
        for name in ["/x", "../x", "a/../b", "a\\b", "a//b", ""] {
            assert!(validate_member(name).is_err());
        }
        assert!(validate_member("logs/run.log").is_ok());
    }
}
