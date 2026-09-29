#[tokio::main]
async fn main() -> anyhow::Result<()> {
    blind::cli::run().await
}
