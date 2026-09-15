#[tokio::main]
async fn main() -> anyhow::Result<()> {
    blind::client::run().await
}
