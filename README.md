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
