# SmartHarvest

SmartHarvest adalah platform integrasi data pertanian dan prediksi ketersediaan panen yang dirancang untuk mendukung layanan *Community Supported Agriculture* (CSA) Tani Sauyunan pada Seni Tani Bandung.

Proyek ini dikembangkan sebagai bagian dari Tugas Besar II3120 Layanan Sistem dan Teknologi Informasi, Kelompok 9 (K-01), Institut Teknologi Bandung, 2026.

## Latar Belakang

Ketidaksesuaian antara estimasi pasokan petani dan hasil panen aktual dapat mengganggu perencanaan serta pemenuhan paket sayuran mingguan anggota CSA. SmartHarvest dirancang untuk mengintegrasikan data pertanian dari berbagai sumber, menghasilkan prediksi kuantitas panen menggunakan AI, dan membantu pengelola Seni Tani mengantisipasi risiko kekurangan pasokan.

## Fitur Utama

- Pengumpulan data pertanian melalui input manual, CSV, dan perangkat IoT.
- Validasi, normalisasi, dan penyimpanan data pertanian.
- Prediksi kuantitas hasil panen menggunakan model AI.
- Penilaian risiko kekurangan pasokan berdasarkan prediksi dan kebutuhan.
- Dashboard koordinator untuk meninjau prediksi, menyetujui ketersediaan, dan menyesuaikan alokasi.
- Portal anggota CSA untuk melihat ketersediaan, memilih sayuran sesuai ketentuan paket, mengakses pembaruan alokasi, dan memberikan umpan balik.
- Pencatatan hasil panen aktual untuk evaluasi.

## Arsitektur Sistem

SmartHarvest menggunakan pendekatan *Service-Oriented Architecture* (SOA) dengan lima layanan logis yang dirancang berdasarkan SoaML pada Deliverable 2. Implementasi awal direncanakan menggunakan satu backend modular dengan REST API sebagai antarmuka integrasi.

| ID | Layanan | Tanggung Jawab |
| --- | --- | --- |
| SVC-01 | Farm Data Integration Service | Menerima, memvalidasi, dan menormalisasi data pertanian. |
| SVC-02 | Farm Record Service | Mengelola data historis pertanian dan hasil panen aktual. |
| SVC-03 | Harvest Prediction Service | Menghasilkan dan menyediakan prediksi kuantitas panen. |
| SVC-04 | Supply Coordination Service | Menilai risiko pasokan serta mendukung persetujuan ketersediaan dan penyesuaian alokasi. |
| SVC-05 | Member Information Service | Menyediakan informasi ketersediaan, pemilihan sayuran, pembaruan alokasi, dan umpan balik anggota. |

Model AI menghasilkan prediksi kuantitas panen dalam kilogram. Penilaian risiko dilakukan melalui aturan bisnis pada backend, sedangkan keputusan persetujuan ketersediaan dan penyesuaian alokasi tetap berada pada koordinator Seni Tani.

## Pengguna Sistem

| Role | Deskripsi |
| --- | --- |
| `FARMER` | Petani mitra yang mengirimkan observasi pertanian dan estimasi panen. |
| `COORDINATOR` | Pengelola Seni Tani yang meninjau prediksi, mengoordinasikan pasokan, dan mencatat hasil panen aktual. |
| `MEMBER` | Anggota CSA yang mengakses informasi, memilih sayuran sesuai ketentuan paket, dan memberikan umpan balik. |

## Struktur Repository

Repository menggunakan pendekatan monorepo. Berikut struktur awal yang direncanakan:

```text
SmartHarvest/
├── backend/          # REST API, business logic, dan database
├── frontend/         # Antarmuka pengguna SmartHarvest
├── ai/               # Preprocessing, training, evaluasi, dan inferensi AI
├── datasets/         # Dataset, pengolahan data, dan dokumentasi sumber
├── iot/              # Firmware perangkat IoT dan simulator
├── docs/             # Spesifikasi, kontrak integrasi, dan referensi proyek
├── README.md         # Dokumentasi utama repository
├── .env.example      # Contoh konfigurasi environment
└── .gitignore        # Konfigurasi file yang diabaikan Git
```

## Technology Stack

Berikut rencana teknologi awal yang akan dikonfirmasi sebelum implementasi.

| Komponen | Teknologi yang Direncanakan |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Backend | Python, FastAPI |
| Database | PostgreSQL, SQLAlchemy, Alembic |
| AI | scikit-learn, RandomForestRegressor, Joblib |
| Data Processing | Pandas, NumPy |
| IoT | ESP32, DHT11/DHT22, HTTP REST API |
| Testing | Pytest |
| Deployment | Docker Compose |

## Pembagian Pengembangan

| Workstream | Direktori | Tanggung Jawab |
| --- | --- | --- |
| Backend | `backend/` | Implementasi layanan, REST API, database, autentikasi, dan otorisasi. |
| Frontend | `frontend/` | Pengembangan antarmuka pengguna dan integrasi REST API. |
| AI Modelling | `ai/` | Pengembangan, evaluasi, dan integrasi model prediksi. |
| Dataset | `datasets/` | Pengumpulan, pembersihan, standardisasi, dan dokumentasi dataset. |
| IoT | `iot/` | Pengambilan data sensor dan integrasi dengan backend. |

Setiap workstream dapat dikembangkan secara paralel berdasarkan kontrak integrasi yang disepakati bersama.

## Getting Started

Clone repository SmartHarvest melalui GitHub, kemudian masuk ke direktori repository hasil clone.

Pada tahap awal, repository masih berfokus pada penyiapan struktur proyek, dokumentasi, dan kontrak integrasi. Instruksi instalasi dependensi, konfigurasi environment, menjalankan aplikasi, melatih model, serta menjalankan pengujian akan ditambahkan setelah komponen terkait diinisialisasi.

Jangan menyimpan kredensial, API token, atau file `.env` berisi rahasia ke repository. Gunakan `.env.example` untuk mendokumentasikan variabel konfigurasi yang diperlukan.

## Status Pengembangan

- [x] Perancangan bisnis dan inovasi layanan (Deliverable 1)
- [x] Perancangan BPMN, SoaML, REST API, dan rencana prototipe (Deliverable 2)
- [ ] Setup repository dan kontrak integrasi
- [ ] Pengumpulan dan pengolahan dataset
- [ ] Pengembangan backend
- [ ] Pengembangan frontend
- [ ] Pengembangan model AI
- [ ] Implementasi IoT
- [ ] Integrasi dan pengujian end-to-end (Deliverable 3)

Prototipe ditargetkan untuk mendemonstrasikan satu periode layanan dengan cakupan 1–2 kebun dan 1–2 komoditas. Penggunaan data sintetis atau simulator IoT harus diberi label secara eksplisit. Hasil demonstrasi dengan data sintetis belum membuktikan akurasi model pada kondisi pertanian nyata.

## Kontributor

Kelompok 9 (K-01) | II3120 Layanan Sistem dan Teknologi Informasi, Institut Teknologi Bandung, 2026.

## Implementasi D3: backend, frontend, dan deployment lokal

Backend menggunakan satu aplikasi FastAPI modular yang mengimplementasikan lima layanan logis SoaML. API-01 sampai API-12 berada di prefix `/api/v1`; dokumentasi kontrak ada di [`docs/api-contract.md`](docs/api-contract.md), traceability di [`docs/soa-traceability.md`](docs/soa-traceability.md), dan OpenAPI di [`docs/openapi.json`](docs/openapi.json). Data sintetik dan hasil model harus tetap diberi label.

### Menjalankan demo lokal dengan Docker Compose

1. Buat konfigurasi lokal dan ganti nilai rahasia untuk lingkungan Anda:

```powershell
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
```

2. Jalankan dari root repository:

```powershell
docker compose up --build
```

Buka `http://127.0.0.1:8080`. Nginx menyajikan frontend dan meneruskan `/api/v1/` ke backend. API, PostgreSQL, broker lokal, dan worker tidak dipublikasikan ke port host. Migrasi Alembic berjalan sebelum API siap. Jangan gunakan nilai contoh untuk akses publik.

Untuk backend langsung saat pengembangan, install dependensi dengan `python -m pip install -r backend/requirements.txt`, siapkan PostgreSQL atau SQLite khusus development, atur `DATABASE_URL` ke database development tersebut, lalu jalankan `python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000`. Untuk frontend Vite, `cd frontend; npm ci; npm run dev`; atur `VITE_API_BASE_URL=/api/v1` dan `API_PROXY_TARGET=http://127.0.0.1:8000` pada `.env.local`.

### Kredensial demo dan role

Login menggunakan username dan password. Bootstrap lokal membuat empat akun (`farmer`, `coordinator`, `member-eligible`, `member-regular`) dengan password acak dari variabel `AUTH_BOOTSTRAP_*` di file `.env` yang tidak dilacak Git. Password hanya dibaca saat akun pertama kali dibuat; ubah password sesudah login melalui menu Akun. Password disimpan sebagai hash Argon2id; browser menerima cookie sesi `HttpOnly`, `SameSite=Lax`, dan `Secure` saat production. Jangan kirim nilai `.env` ke chat atau commit. Login tidak mengizinkan pilihan role; role dan scope ditentukan di server. Farm demo adalah `FARM-01`, crop `SPINACH`, periode seed `2026-W48`. Akun anggota eligible adalah `MBR-001`, sedangkan paket reguler adalah `MBR-002`.

### MQTT lokal dan HiveMQ yang sudah ada

MQTT ingestion mati secara default. Untuk simulator terisolasi, isi `.env` dengan `MQTT_ENABLED=true`, `MQTT_HOST=mqtt`, `MQTT_FARM_ID=FARM-01`, `MQTT_DEVICE_ID=SYN-ESP32-01`, dan `MQTT_SOURCE=simulated_iot`, lalu jalankan `docker compose --profile local-mqtt up --build`. Kirim fixture hanya ke broker lokal:

```powershell
docker compose exec api python -m backend.app.mqtt_simulator --host mqtt
```

Jika broker berjalan di jaringan Compose, gunakan `--host mqtt` dari container backend/simulator. Jangan arahkan simulator ke broker publik.

Mode HiveMQ memakai host `broker.hivemq.com`, TCP `1883`, topic persis `tani/sensor/lingkungan`, QoS 0, tanpa kredensial (konfigurasi sesuai teammate). Aktifkan hanya bila diperlukan dengan `MQTT_ENABLED=true`, `MQTT_FARM_ID` dan `MQTT_DEVICE_ID` yang telah dikonfigurasi. Payload BME280 terbaru memiliki `hum`; humidity opsional dan tidak diisi ketika tidak diterima. Firmware terbaru tidak mengirim device/block ID maupun timestamp, sehingga konfigurasi server mengikat topic ke demo farm/device dan backend mencatat waktu terima. Broker publik tidak memverifikasi sumber fisik, tidak terenkripsi, dan tidak menjamin pengiriman. Lihat [`docs/mqtt-contract.md`](docs/mqtt-contract.md).

### Model AI yang ada dan penggantian kemudian

Backend memuat hanya file lokal tepercaya dari `MODEL_PATH` (default image `/app/ai/models/model.joblib`) melalui `ai/src/predict.py`; runtime dipin ke scikit-learn 1.9.1 sesuai metadata model. Artifact saat ini bernama `rf-synthetic-v3`, berasal dari dataset sintetik dan bukan bukti akurasi kebun nyata. Ganti hanya melalui adapter predictor, setelah artifact baru tersedia, kontrak fitur/satuan dan dependensi diverifikasi. Atur path eksplisit, uji route dan konversi kg/m² ke kg total, simpan version/provenance, dan pertahankan respons `PREDICTION_UNAVAILABLE` serta persetujuan manual `MANUAL_ESTIMATE` saat model tidak kompatibel. Jangan latih atau mengganti model pada tugas ini.

### Skenario Demo (`operational` & `walkthrough`)

Untuk mengisi dataset demo (2 kebun: Kebun Ciburial & Kebun Cimenyan, 5 komoditas sayuran, 6 penanaman aktif, 6 anggota CSA, riwayat sensor 7 hari, dan periode evaluasi sebelumnya):

```powershell
# Skenario operasional (siap jelajah langsung)
docker compose exec api python -m backend.app.seed --scenario operational --period 2026-W48 --reset-demo

# Skenario walkthrough BPMN interaktif (belum ada persetujuan minggu aktif)
docker compose exec api python -m backend.app.seed --scenario walkthrough --period 2026-W48 --reset-demo
```

Flag `--reset-demo` hanya membersihkan data demo dan **tidak** menghapus observasi MQTT `source=iot` maupun akun pengguna.

Ilustrasi sayuran dibuat menggunakan fitur generasi gambar OpenAI (ChatGPT), 26 November 2026, untuk keperluan prototipe SmartHarvest. Ilustrasi bukan dokumentasi hasil panen aktual.

### Pengujian dan status

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q -p no:cacheprovider
cd frontend; npm.cmd run build
cd ..; docker compose --env-file .env.example config --quiet
```

Hasil pengujian dan batasan deployment ada di docs/d3-test-results.md serta docs/backend-implementation-status.md. Compose dan tunnel aktif; frontend dan API memakai satu hostname. HiveMQ tersambung, tetapi sensor fisik belum mengirim data pada jendela pemeriksaan. Dataset suite masih membutuhkan generate_dataset.py yang tidak ada di tree.

### Cloudflare Tunnel

Tunnel sudah aktif: satu hostname menyajikan frontend dan meneruskan `/api/v1/` ke backend. Password bootstrap hanya ada pada `.env` lokal yang Git-ignored; ganti masing-masing setelah login dan bagikan secara privat. Periksa status dengan `docker compose --env-file .env --profile tunnel ps`. Rollback akses publik dengan `docker compose --env-file .env --profile tunnel stop tunnel` lalu nonaktifkan hostname route/DNS di Cloudflare. Detail verifikasi ada pada docs/cloudflare-tunnel.md.

Dokumentasi keamanan: [`docs/security-review.md`](docs/security-review.md) dan [`docs/security-threat-model.md`](docs/security-threat-model.md).
