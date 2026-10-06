use crate::{
    runtime::network::HostCandidate,
    scene::{MeshQuality, SceneUpdate},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct ShareLinks {
    pub ttl_days: u32,
    pub viewer_url: String,
    pub image_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ShareResponse {
    #[serde(flatten)]
    pub(super) links: ShareLinks,
    /// Origin used to compose the links, echoed for the share-sheet host picker.
    pub(super) origin: String,
    pub(super) hosts: Vec<HostCandidate>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateSceneRequest {
    #[serde(default)]
    pub(super) viewport: Option<crate::scene::ViewportState>,
    #[serde(default)]
    pub(super) collection: Option<CreateCollectionRequest>,
    #[serde(default)]
    pub(super) display: Vec<crate::scene::component::DisplayOptions>,
    #[serde(default = "crate::scene::default_ttl_days")]
    pub(super) ttl_days: u32,
    #[serde(default)]
    pub(super) manifest: Option<crate::plugin::ShareManifest>,
    #[serde(default)]
    pub(super) renderers: Vec<crate::plugin::RendererBundle>,
    #[serde(default)]
    pub(super) paths: Vec<String>,
    pub(super) title: Option<String>,
    pub(super) origin: Option<String>,
    pub(super) labels: Option<Vec<Option<crate::scene::MeshLabel>>>,
    #[serde(default)]
    pub(super) label_groups: Vec<crate::scene::MeshLabelGroup>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateCollectionRequest {
    pub(super) title: String,
    pub(super) active_scene_id: String,
    pub(super) scenes: Vec<CreateCollectionPart>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateCollectionPart {
    #[serde(default)]
    pub(super) viewport: Option<crate::scene::ViewportState>,
    pub(super) id: String,
    pub(super) title: String,
    #[serde(default)]
    pub(super) manifest: Option<crate::plugin::ShareManifest>,
    #[serde(default)]
    pub(super) renderers: Vec<crate::plugin::RendererBundle>,
    #[serde(default)]
    pub(super) paths: Vec<String>,
    #[serde(default)]
    pub(super) display: Vec<crate::scene::component::DisplayOptions>,
    #[serde(default)]
    pub(super) labels: Vec<Option<crate::scene::MeshLabel>>,
    #[serde(default)]
    pub(super) label_groups: Vec<crate::scene::MeshLabelGroup>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ReshareRequest {
    #[serde(flatten)]
    pub(super) update: SceneUpdate,
}

#[derive(Debug, Serialize)]
pub(super) struct HealthResponse {
    pub(super) status: &'static str,
    pub(super) version: &'static str,
    pub(super) scene_schema: u8,
    pub(super) image_renderer: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct PublicScene {
    pub(super) entities: Vec<crate::scene::component::SceneEntity>,
    pub(super) ttl_days: u32,
    pub(super) source: Option<crate::scene::SceneSource>,
    pub(super) title: String,
    pub(super) meshes: Vec<PublicMesh>,
    pub(super) label_groups: Vec<crate::scene::MeshLabelGroup>,
    pub(super) state: crate::scene::ViewState,
    pub(super) owner: bool,
    pub(super) attachments: Vec<serde_json::Value>,
    pub(super) warnings: Vec<crate::scene::Warning>,
}

#[derive(Debug, Serialize)]
pub(super) struct PublicMesh {
    pub(super) name: String,
    pub(super) format: crate::scene::MeshFormat,
    pub(super) revision: String,
    pub(super) byte_size: u64,
    pub(super) color: String,
    pub(super) opacity: f32,
    pub(super) visible: bool,
    pub(super) quality: MeshQuality,
    pub(super) label: Option<crate::scene::MeshLabel>,
    pub(super) source_url: String,
    pub(super) translation: [f32; 3],
}
