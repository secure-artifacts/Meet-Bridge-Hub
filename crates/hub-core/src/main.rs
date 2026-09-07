use meet_bridge_hub_core::{HubConfig, HubService};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    let hub = HubService::new(HubConfig::default());
    tracing::info!(address = %hub.status().bind_addr, "Meet Bridge Hub Core started");
    hub.serve().await
}
