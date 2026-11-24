//! 分层皮肤（`kind: "layered"`）的几何与图片校验。纯逻辑、不依赖 JSON 库：
//! 应用层把皮肤包里的 `rig` 摊平成 `RigFacts` 再交给这里。

use crate::skin::{sniff_image, ImageKind, MAX_IMAGE_BYTES, MAX_PNG_SIDE};

pub const MAX_IMAGES: usize = 16;
pub const MAX_TOTAL_IMAGE_BYTES: usize = 6_000_000;
pub const MAX_PACK_BYTES: usize = 12_000_000;
pub const MAX_ATTACH: f64 = 2000.0;
pub const MAX_SEGMENTS: usize = 3;
pub const MIN_SCALE: f64 = 0.1;
pub const MAX_SCALE: f64 = 4.0;
/// 支点到终点的最小归一化距离，避免方向未定义。
pub const MIN_END_DIST: f64 = 0.05;

pub struct PartFacts {
    /// 例如 "torso"、"head"、"limb.fl"、"limb.fl.seg0"、"tail"
    pub name: String,
    pub pivot: [f64; 2],
    pub end: Option<[f64; 2]>,
    /// 只有顶层部位有 attach / z；分段没有
    pub attach: Option<[f64; 2]>,
    pub z: Option<i64>,
    pub segments: usize,
}

pub struct RigFacts<'a> {
    pub scale: f64,
    pub parts: Vec<PartFacts>,
    /// (图片名, 解码后的字节)
    pub images: Vec<(&'a str, &'a [u8])>,
}

fn in_unit(v: f64) -> bool {
    (0.0..=1.0).contains(&v)
}

pub fn validate_rig(r: &RigFacts) -> Vec<String> {
    let mut e = Vec::new();
    if !(MIN_SCALE..=MAX_SCALE).contains(&r.scale) {
        e.push("bad-scale".into());
    }
    for need in ["torso", "head"] {
        if !r.parts.iter().any(|p| p.name == need) {
            e.push(format!("missing-{need}"));
        }
    }
    let mut seen: Vec<&str> = Vec::new();
    for p in &r.parts {
        if seen.contains(&p.name.as_str()) {
            e.push(format!("duplicate-part:{}", p.name));
        }
        seen.push(&p.name);
        if !in_unit(p.pivot[0]) || !in_unit(p.pivot[1]) {
            e.push(format!("bad-pivot:{}", p.name));
        }
        if let Some(end) = p.end {
            let d = ((end[0] - p.pivot[0]).powi(2) + (end[1] - p.pivot[1]).powi(2)).sqrt();
            if !in_unit(end[0]) || !in_unit(end[1]) || d < MIN_END_DIST {
                e.push(format!("bad-end:{}", p.name));
            }
        }
        if let Some(a) = p.attach {
            if a[0].abs() > MAX_ATTACH || a[1].abs() > MAX_ATTACH {
                e.push(format!("bad-attach:{}", p.name));
            }
        }
        if let Some(z) = p.z {
            if !(-100..=100).contains(&z) {
                e.push(format!("bad-z:{}", p.name));
            }
        }
        if p.segments > MAX_SEGMENTS {
            e.push(format!("too-many-segments:{}", p.name));
        }
    }

    if r.images.len() > MAX_IMAGES {
        e.push("too-many-images".into());
    }
    let mut total = 0usize;
    for (name, bytes) in &r.images {
        total += bytes.len();
        if bytes.len() > MAX_IMAGE_BYTES {
            e.push(format!("image-too-large:{name}"));
        }
        match sniff_image(bytes) {
            None => e.push(format!("not-an-image:{name}")),
            Some(ImageKind::Png { w, h }) if w == 0 || h == 0 || w > MAX_PNG_SIDE || h > MAX_PNG_SIDE => {
                e.push(format!("image-dimensions:{name}"))
            }
            _ => {}
        }
    }
    if total > MAX_TOTAL_IMAGE_BYTES {
        e.push("images-total-too-large".into());
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
    fn part(name: &str) -> PartFacts {
        PartFacts { name: name.into(), pivot: [0.5, 0.5], end: None, attach: Some([0.0, 0.0]), z: Some(0), segments: 0 }
    }

    #[test]
    fn minimal_torso_and_head_is_valid() {
        let p = png(64, 64);
        let r = RigFacts { scale: 1.0, parts: vec![part("torso"), part("head")], images: vec![("torso", &p), ("head", &p)] };
        assert!(validate_rig(&r).is_empty());
    }

    #[test]
    fn torso_and_head_are_required() {
        let r = RigFacts { scale: 1.0, parts: vec![part("torso")], images: vec![] };
        assert_eq!(validate_rig(&r), vec!["missing-head"]);
        let r = RigFacts { scale: 1.0, parts: vec![], images: vec![] };
        assert_eq!(validate_rig(&r), vec!["missing-torso", "missing-head"]);
    }

    #[test]
    fn geometry_ranges_are_enforced() {
        let mut t = part("torso");
        t.pivot = [1.5, 0.5];
        t.attach = Some([5000.0, 0.0]);
        t.z = Some(500);
        let mut limb = part("limb.fl");
        limb.end = Some([0.5, 0.52]); // 与支点太近
        let r = RigFacts { scale: 9.0, parts: vec![t, part("head"), limb], images: vec![] };
        let e = validate_rig(&r);
        for want in ["bad-scale", "bad-pivot:torso", "bad-attach:torso", "bad-z:torso", "bad-end:limb.fl"] {
            assert!(e.contains(&want.to_string()), "{want} in {e:?}");
        }
    }

    #[test]
    fn duplicate_parts_and_too_many_segments() {
        let mut tail = part("tail");
        tail.segments = 4;
        let r = RigFacts { scale: 1.0, parts: vec![part("torso"), part("head"), part("head"), tail], images: vec![] };
        let e = validate_rig(&r);
        assert!(e.contains(&"duplicate-part:head".to_string()));
        assert!(e.contains(&"too-many-segments:tail".to_string()));
    }

    #[test]
    fn image_limits_are_enforced() {
        let ok = png(64, 64);
        let big_dim = png(4000, 10);
        let junk = vec![1u8; 100];
        let r = RigFacts {
            scale: 1.0,
            parts: vec![part("torso"), part("head")],
            images: vec![("torso", &ok), ("head", &big_dim), ("tail", &junk)],
        };
        let e = validate_rig(&r);
        assert!(e.contains(&"image-dimensions:head".to_string()));
        assert!(e.contains(&"not-an-image:tail".to_string()));
        let many: Vec<(&str, &[u8])> = (0..17).map(|_| ("x", ok.as_slice())).collect();
        let r = RigFacts { scale: 1.0, parts: vec![part("torso"), part("head")], images: many };
        assert!(validate_rig(&r).contains(&"too-many-images".to_string()));
    }
}
