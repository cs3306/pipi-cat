//! 皮肤包（.petskin）的纯校验逻辑：不解析 JSON，只检查已取出的字段与图片字节。
//! 皮肤包是不可信的下载内容，所以这里的规则偏严：只允许数据（颜色 / 图片），有大小上限，
//! 图片必须是真正的 PNG / WebP（看文件头，不信扩展名与 MIME）。

pub const SCHEMA: u32 = 1;
pub const MAX_IMAGE_BYTES: usize = 1_500_000;
pub const MAX_TOTAL_IMAGE_BYTES: usize = 4_000_000;
pub const MAX_PNG_SIDE: u32 = 2048;
pub const SPRITE_SLOTS: [&str; 4] = ["idle", "blink", "happy", "shy"];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ImageKind {
    Png { w: u32, h: u32 },
    Webp,
}

/// `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`
pub fn is_hex_color(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('#') else { return false };
    matches!(rest.len(), 3 | 4 | 6 | 8) && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 小写字母/数字/连字符，3..=30（上游猫 id 最长 36，加 `skin-` 前缀后不能被截断），首字符为字母或数字。
pub fn is_valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=30).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn sniff_image(bytes: &[u8]) -> Option<ImageKind> {
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() >= 24 && bytes[..8] == PNG && &bytes[12..16] == b"IHDR" {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some(ImageKind::Png { w, h });
    }
    if bytes.len() >= 16 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    None
}

/// 标准 base64（带 `=` 填充，不允许空白）。
pub fn b64_decode(s: &str) -> Result<Vec<u8>, &'static str> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let b = s.as_bytes();
    if b.len() % 4 != 0 {
        return Err("bad-base64-length");
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    for (i, chunk) in b.chunks(4).enumerate() {
        let last = i == b.len() / 4 - 1;
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return Err("bad-base64-padding");
        }
        let mut n: u32 = 0;
        for (j, &c) in chunk.iter().enumerate() {
            let v = if j >= 4 - pad {
                0
            } else {
                val(c).ok_or("bad-base64-char")?
            };
            n = (n << 6) | v;
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// 取出 `data:image/png;base64,` / `data:image/webp;base64,` 之后的 base64 部分。
pub fn strip_data_uri(s: &str) -> Option<&str> {
    s.strip_prefix("data:image/png;base64,").or_else(|| s.strip_prefix("data:image/webp;base64,"))
}

pub struct PackFacts<'a> {
    pub schema: u32,
    pub id: &'a str,
    pub name: &'a str,
    pub author: &'a str,
    pub license: &'a str,
    pub version: &'a str,
    pub kind: &'a str,
    pub has_palette: bool,
    /// (槽位名, 解码后的图片字节)
    pub images: Vec<(&'a str, &'a [u8])>,
}

fn len_ok(s: &str, max: usize) -> bool {
    let n = s.trim().chars().count();
    (1..=max).contains(&n)
}

/// 返回所有问题（空 = 通过）。错误码是英文短语，界面再翻译。
pub fn validate(p: &PackFacts) -> Vec<String> {
    let mut e = Vec::new();
    if p.schema != SCHEMA {
        e.push(format!("unsupported-schema:{}", p.schema));
    }
    if !is_valid_id(p.id) {
        e.push("bad-id".into());
    }
    if !len_ok(p.name, 40) {
        e.push("bad-name".into());
    }
    if !len_ok(p.author, 60) {
        e.push("missing-author".into());
    }
    if !len_ok(p.license, 60) {
        e.push("missing-license".into());
    }
    if !len_ok(p.version, 20) {
        e.push("bad-version".into());
    }
    match p.kind {
        "palette" => {
            if !p.has_palette {
                e.push("palette-missing".into());
            }
            if !p.images.is_empty() {
                e.push("palette-skin-cannot-contain-images".into());
            }
        }
        "sprites" => {
            if p.has_palette {
                e.push("sprites-skin-cannot-contain-palette".into());
            }
            let mut total = 0usize;
            let mut seen: Vec<&str> = Vec::new();
            for (slot, bytes) in &p.images {
                if !SPRITE_SLOTS.contains(slot) {
                    e.push(format!("unknown-slot:{slot}"));
                    continue;
                }
                if seen.contains(slot) {
                    e.push(format!("duplicate-slot:{slot}"));
                }
                seen.push(slot);
                total += bytes.len();
                if bytes.len() > MAX_IMAGE_BYTES {
                    e.push(format!("image-too-large:{slot}"));
                }
                match sniff_image(bytes) {
                    None => e.push(format!("not-an-image:{slot}")),
                    Some(ImageKind::Png { w, h }) if w == 0 || h == 0 || w > MAX_PNG_SIDE || h > MAX_PNG_SIDE => {
                        e.push(format!("image-dimensions:{slot}"))
                    }
                    _ => {}
                }
            }
            if total > MAX_TOTAL_IMAGE_BYTES {
                e.push("images-total-too-large".into());
            }
            if !seen.contains(&"idle") {
                e.push("missing-idle-image".into());
            }
        }
        "layered" => {
            // 分层皮肤的图片和几何由 rig::validate_rig 校验；这里只确保没有混入别的种类的内容。
            if p.has_palette {
                e.push("layered-skin-cannot-contain-palette".into());
            }
            if !p.images.is_empty() {
                e.push("layered-skin-cannot-contain-sprites".into());
            }
        }
        other => e.push(format!("unknown-kind:{other}")),
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    fn facts<'a>(kind: &'a str, imgs: Vec<(&'a str, &'a [u8])>, palette: bool) -> PackFacts<'a> {
        PackFacts { schema: 1, id: "my-skin", name: "My", author: "me", license: "CC-BY-4.0", version: "1.0.0", kind, has_palette: palette, images: imgs }
    }

    #[test]
    fn hex_colors() {
        for ok in ["#fff", "#ffff", "#a1b2c3", "#a1b2c3d4"] {
            assert!(is_hex_color(ok), "{ok}");
        }
        for bad in ["fff", "#ff", "#ggg", "red", "#12345", "url(#x)", "#fff;x"] {
            assert!(!is_hex_color(bad), "{bad}");
        }
    }

    #[test]
    fn ids() {
        assert!(is_valid_id("cool-cat-2"));
        for bad in ["ab", "-abc", "Abc", "a b", "../x", "a_b", &"x".repeat(31)] {
            assert!(!is_valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn base64_roundtrip_and_errors() {
        assert_eq!(b64_decode("").unwrap(), b"");
        assert_eq!(b64_decode("TQ==").unwrap(), b"M");
        assert_eq!(b64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(b64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(b64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert!(b64_decode("TWF").is_err());
        assert!(b64_decode("TW=u").is_err());
        assert!(b64_decode("T=Fu").is_err());
        assert!(b64_decode("TW Fu").is_err());
    }

    #[test]
    fn sniffing_trusts_bytes_not_names() {
        assert_eq!(sniff_image(&png(10, 20)), Some(ImageKind::Png { w: 10, h: 20 }));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        webp.extend_from_slice(&[0; 8]);
        assert_eq!(sniff_image(&webp), Some(ImageKind::Webp));
        assert_eq!(sniff_image(b"<svg onload=alert(1)>"), None);
        assert_eq!(sniff_image(b"MZ\x90\0"), None);
    }

    #[test]
    fn data_uri_prefixes() {
        assert_eq!(strip_data_uri("data:image/png;base64,AAAA"), Some("AAAA"));
        assert_eq!(strip_data_uri("data:image/svg+xml;base64,AAAA"), None);
        assert_eq!(strip_data_uri("http://x/y.png"), None);
    }

    #[test]
    fn valid_sprite_pack_passes() {
        let a = png(300, 300);
        let b = png(300, 300);
        assert!(validate(&facts("sprites", vec![("idle", &a), ("blink", &b)], false)).is_empty());
    }

    #[test]
    fn sprite_pack_problems_are_all_reported() {
        let big = png(5000, 10);
        let junk = b"not an image at all, definitely".to_vec();
        let errs = validate(&facts("sprites", vec![("idle", &big), ("evil", &junk), ("blink", &junk)], false));
        assert!(errs.iter().any(|e| e == "image-dimensions:idle"));
        assert!(errs.iter().any(|e| e == "unknown-slot:evil"));
        assert!(errs.iter().any(|e| e == "not-an-image:blink"));
        let errs = validate(&facts("sprites", vec![], false));
        assert!(errs.contains(&"missing-idle-image".to_string()));
    }

    #[test]
    fn size_limits() {
        let mut huge = png(100, 100);
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(validate(&facts("sprites", vec![("idle", &huge)], false)).contains(&"image-too-large:idle".to_string()));
        let mut ok = png(100, 100);
        ok.resize(1_400_000, 0);
        let errs = validate(&facts("sprites", vec![("idle", &ok), ("blink", &ok), ("happy", &ok)], false));
        assert!(errs.contains(&"images-total-too-large".to_string()));
    }

    #[test]
    fn palette_and_kind_rules() {
        assert!(validate(&facts("palette", vec![], true)).is_empty());
        assert!(validate(&facts("palette", vec![], false)).contains(&"palette-missing".to_string()));
        let a = png(10, 10);
        assert!(validate(&facts("palette", vec![("idle", &a)], true)).iter().any(|e| e.starts_with("palette-skin-cannot")));
        assert!(validate(&facts("layered", vec![], false)).is_empty());
        assert!(validate(&facts("layered", vec![], true)).contains(&"layered-skin-cannot-contain-palette".to_string()));
        assert!(validate(&facts("layered", vec![("idle", &a)], false)).contains(&"layered-skin-cannot-contain-sprites".to_string()));
        assert!(validate(&facts("script", vec![], false)).iter().any(|e| e.starts_with("unknown-kind")));
    }

    #[test]
    fn metadata_is_required() {
        let mut f = facts("palette", vec![], true);
        f.license = "  ";
        f.author = "";
        f.schema = 2;
        let errs = validate(&f);
        assert!(errs.contains(&"missing-license".to_string()));
        assert!(errs.contains(&"missing-author".to_string()));
        assert!(errs.contains(&"unsupported-schema:2".to_string()));
    }
}
