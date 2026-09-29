//! Image export through GPU rendering, browser capture, and collection composition.
pub(crate) mod browser;
pub(crate) mod collection;
mod gpu;
mod labels;
mod occlusion;

pub use gpu::Renderer;
pub(crate) use gpu::overlay_collection_strokes;
