# SpeedMap

> Real-Time Global Broadband Mapping and Network Diagnostics Platform

SpeedMap is a lightweight, privacy-focused web application engineered for diagnostic bandwidth benchmarking, spatial coverage mapping, and automated ISP outage detection. Built with zero framework overhead, it combines client-side throughput measurement with an interactive Leaflet geospatial engine.

---

## Key Features

- **Diagnostic Bandwidth Engine**: Measures Download throughput (Mbps), Upload throughput (Mbps), Latency ping (ms), Jitter variance (ms), and Packet Loss (%) with multi-threaded streaming.
- **Geospatial Coverage Visualization**: Plots mapped speed benchmarks worldwide using dark-theme vector markers, speed classification tiers, and kernel density heatmap overlays with one-click ISP filtering.
- **Automated Health & Outage Inspector**: Continuously monitors regional network status to identify latency spikes ($\ge 120\text{ ms}$) and throughput degradation ($< 12\text{ Mbps}$) across providers.
- **24-Hour Congestion Forecast**: Aggregates hourly telemetry to forecast peak congestion windows and calculate optimal off-peak hours for bandwidth-intensive workloads.
- **Regional Leaderboards**: Aggregates performance metrics across internet service providers, municipal regions, and global speed distributions.
- **Telemetry Export & Social Cards**: Renders custom HTML5 canvas summary cards and supports structured CSV data exports.

---

## Architecture & Technology Stack

- **Core Runtime**: Vanilla JavaScript (ES6+), HTML5, CSS3 Glassmorphism
- **Mapping Framework**: [Leaflet.js](https://leafletjs.com/) with [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) plugin
- **Cartographic Basemaps**: CARTO Dark Matter Basemap Services
- **Data Persistence**: HTML5 LocalStorage with REST / Cloud Data Synchronization API

---

## Getting Started

SpeedMap requires no external package managers or compilation pipelines. Serve the root directory using any HTTP server:

```bash
# Clone repository
git clone https://github.com/belkysupreme22/SpeedMap.git
cd SpeedMap

# Launch local HTTP server
python -m http.server 5500
```

Access the application in your browser at `http://localhost:5500`.

---

## License

This project is licensed under the MIT License - see the `LICENSE` file for details.
