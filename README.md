# SmartHarvest

**Sistem Informasi Pertanian Prediktif Berbasis Layanan untuk CSA Tani Sauyunan**

SmartHarvest mendigitalisasi operasional *Community Supported Agriculture* (CSA) Tani Sauyunan / Seni Tani Bandung (II3120 Layanan Sistem Teknologi Informasi, Kelompok 9 K-01 ITB 2026). Platform ini mengintegrasikan telemetri sensor IoT, prediksi hasil panen berbasis *machine learning*, serta manajemen penawaran dan alokasi paket sayuran mingguan dalam satu alur kerja berbasis layanan.

## Fitur Utama

- **Monitoring Lahan & IoT**: ingest pembacaan sensor lingkungan melalui MQTT (`ESP32` + `BME280` + `HW-390`), input manual, maupun impor CSV.
- **Prediksi Panen (AI)**: estimasi hasil panen berbasis model *machine learning* (`scikit-learn`) yang ditampilkan berdampingan dengan perkiraan petani untuk evaluasi akurasi.
- **Manajemen Panen & Smart Allocation**: pencatatan perkiraan panen, penawaran mingguan, rekomendasi alokasi otomatis (*Smart Allocation*) dengan peringatan kekurangan stok, penyesuaian paket per anggota, serta pencatatan realisasi panen.
- **Portal Anggota CSA**: dukungan **Paket Custom** (pilih preferensi sayuran mingguan) dan **Paket Reguler** (paket kurasi koordinator), perpindahan paket untuk periode berikutnya, status pengiriman & konfirmasi terima paket, serta ulasan paket.

## Arsitektur Layanan (SOA)

Backend dibangun sebagai satu aplikasi FastAPI modular yang mengimplementasikan 5 layanan logis sesuai model SoaML dengan kontrak API terdokumentasi di OpenAPI (`/api/v1`).

| ID | Layanan | Tanggung Jawab Utama |
| --- | --- | --- |
| `SVC-01` | **Monitoring & IoT Service** | Ingest data sensor (MQTT/manual/CSV) dan ringkasan kondisi lahan |
| `SVC-02` | **AI Harvest Prediction Service** | Inferensi prediksi hasil panen berbasis data lahan & komoditas |
| `SVC-03` | **Harvest & Offering Management Service** | Perkiraan panen petani, daftar penawaran mingguan, dan realisasi panen |
| `SVC-04` | **Member & Subscription Management Service** | Profil anggota, tier paket (`Paket Custom` / `Paket Reguler`), preferensi mingguan, dan pergantian paket periode berikutnya |
| `SVC-05` | **Allocation & Delivery Management Service** | *Smart Allocation*, jadwal distribusi, konfirmasi penerimaan, ulasan, dan notifikasi |

## Peran Pengguna

| Peran | Deskripsi |
| --- | --- |
| `FARMER` | Petani yang memantau kondisi lahan/IoT, menginput perkiraan panen, dan mencatat realisasi panen. |
| `COORDINATOR` | Koordinator CSA yang mengelola penawaran mingguan, menjalankan *Smart Allocation*, mengatur paket anggota, dan memantau distribusi. |
| `MEMBER` | Anggota CSA (**Paket Custom** atau **Paket Reguler**) yang mengatur preferensi/paket periode berikutnya, melacak pengiriman, mengonfirmasi penerimaan, dan memberi ulasan. |

## Tech Stack

| Layer | Teknologi |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| Backend | Python, FastAPI |
| Database | PostgreSQL, SQLAlchemy, Alembic |
| Machine Learning | scikit-learn, Joblib, Pandas, NumPy |
| IoT & Broker | ESP32, BME280, HW-390, MQTT (Mosquitto / HiveMQ Cloud) |
| Testing & Deployment | Pytest, Docker Compose, Nginx, Cloudflare Tunnel (opsional) |

## Struktur Repository

```text
Smart-Harvest/
├── ai/                  # Notebook, eksperimen, dan artefak model ML
├── backend/             # Aplikasi FastAPI modular (SVC-01..SVC-05), Alembic, seed & tests
├── docs/                # Kontrak API, OpenAPI spec, SoaML traceability, MQTT & tunnel docs
├── frontend/            # Aplikasi web React + TypeScript + Vite
├── infra/               # Konfigurasi Nginx dan broker MQTT lokal
├── iot/                 # Firmware ESP32 & utilitas sensor
├── docker-compose.yml   # Orkestrasi db, migrate, api, web, local-mqtt, tunnel
└── .env.example         # Template variabel environment
```

## Cara Menjalankan

### Prasyarat

- **Docker & Docker Compose** (rekomendasi untuk menjalankan seluruh stack), atau
- **Python 3.11+**, **Node.js 20+**, dan **PostgreSQL** (untuk pengembangan lokal tanpa Docker).

### 1. Menjalankan dengan Docker Compose (Rekomendasi)

1. Salin template environment dan sesuaikan kredensial serta akun bootstrap di `.env` (jangan pernah commit `.env`):
   ```powershell
   Copy-Item .env.example .env
   ```
   *(Di Linux/macOS gunakan `cp .env.example .env`)*
2. Bangun dan jalankan seluruh layanan (`db`, `migrate`, `api`, `web`):
   ```bash
   docker compose --env-file .env up -d --build
   ```
3. Akses aplikasi web di `http://127.0.0.1:8080` (atau sesuai `WEB_PORT` di `.env`) dan dokumentasi OpenAPI di `http://127.0.0.1:8080/docs`.

### 2. Seed & Reset Data Demo

Jalankan perintah berikut untuk mengisi atau mereset data demo:

- **Mode operasional (default):**
  ```bash
  docker compose --env-file .env exec api python -m app.seed_demo --mode operational --reset-demo
  ```
- **Mode walkthrough:**
  ```bash
  docker compose --env-file .env exec api python -m app.seed_demo --mode walkthrough --reset-demo
  ```

> Flag `--reset-demo` mereset data operasional demo tanpa menghapus akun pengguna maupun data telemetri MQTT live.

### 3. Pengembangan Lokal (Tanpa Docker)

Pastikan PostgreSQL berjalan dan variabel database di `.env` sudah sesuai, lalu jalankan backend dan frontend di terminal terpisah:

- **Backend:**
  ```bash
  cd backend
  python -m venv .venv
  # Aktifkan venv (.venv\Scripts\Activate.ps1 di Windows atau source .venv/bin/activate di Linux/macOS)
  pip install -r requirements.txt
  alembic upgrade head
  uvicorn app.main:app --reload --port 8000
  ```
- **Frontend:**
  ```bash
  cd frontend
  npm ci
  npm run dev
  ```
  Server Vite berjalan di `http://localhost:5173` dan meneruskan request `/api` ke `http://127.0.0.1:8000`.

### 4. MQTT & Cloudflare Tunnel (Opsional)

- **Broker MQTT lokal:**
  ```bash
  docker compose --env-file .env --profile local-mqtt up -d
  ```
  Lihat kontrak topik & payload di [`docs/mqtt-contract.md`](docs/mqtt-contract.md).
- **Cloudflare Tunnel:**
  ```bash
  docker compose --env-file .env --profile tunnel up -d
  ```
  Lihat panduan konfigurasi di [`docs/cloudflare-tunnel.md`](docs/cloudflare-tunnel.md).

### 5. Menjalankan Pengujian

- **Backend:**
  ```bash
  cd backend
  pytest
  ```
- **Frontend:**
  ```bash
  cd frontend
  npm test
  npm run build
  ```

## Dokumentasi

- [`docs/api-contract.md`](docs/api-contract.md) — Daftar kontrak REST API (`/api/v1`)
- [`docs/soa-traceability.md`](docs/soa-traceability.md) — Pemetaan layanan SoaML ke endpoint backend
- [`docs/openapi.json`](docs/openapi.json) — Spesifikasi OpenAPI
- [`docs/mqtt-contract.md`](docs/mqtt-contract.md) — Kontrak topik & payload IoT MQTT
- [`docs/cloudflare-tunnel.md`](docs/cloudflare-tunnel.md) — Konfigurasi Cloudflare Tunnel
- [`docs/security-review.md`](docs/security-review.md) — Catatan tinjauan keamanan

## Kontributor

**Kelompok 9 — Kelas 01 (K-01)** | II3120 Layanan Sistem Teknologi Informasi, Institut Teknologi Bandung, 2026.

*Ilustrasi sayuran dibuat menggunakan fitur generasi gambar OpenAI (ChatGPT).*
