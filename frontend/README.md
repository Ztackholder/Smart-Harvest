# SmartHarvest Frontend

Antarmuka React, TypeScript, Vite, dan Tailwind CSS untuk petani, koordinator, dan anggota CSA Tani Sauyunan.

## Menjalankan frontend

Gunakan Node.js 20.19+ pada lini 20, atau 22.12+.

```sh
cd frontend
npm ci
npm run dev
```

Buka http://127.0.0.1:5173. Mode simulasi aktif saat `VITE_API_BASE_URL` kosong. Pilih peran dari menu akun. Perubahan demo disimpan di browser yang sama. Hapus data situs untuk mengembalikan contoh awal.

```sh
npm run build
npm run preview
```

## Menyambungkan REST API

Isi `.env.local` berdasarkan `.env.example`, lalu jalankan ulang Vite. Gunakan prefix `/api/v1` tanpa garis miring akhir.

```dotenv
VITE_API_BASE_URL=/api/v1
API_PROXY_TARGET=http://127.0.0.1:8000
VITE_DEFAULT_PERIOD=2026-W46
```

`API_PROXY_TARGET` hanya berlaku di server Vite. Untuk deployment, arahkan `/api/v1` ke backend via reverse proxy, atau gunakan URL lengkap dan atur CORS di backend. Masuk dengan peran yang sesuai dan token Bearer dari tim backend. Token berada di memori tab dan hilang saat halaman dimuat ulang. Pengguna anggota memilih jenis paket sesuai akun uji. Backend memverifikasi peran, hak memilih, kepemilikan data, kuota, dan status paket.

| Layar | Operasi D2 |
| --- | --- |
| Observasi dan estimasi petani | API-01 dan API-02 |
| Prediksi dan penilaian risiko | API-03, API-04, API-11 |
| Persetujuan dan penyesuaian | API-05, API-06, API-08 |
| Hasil panen aktual | API-09 |
| Sayuran, pilihan, dan umpan balik anggota | API-06, API-07, API-10 |
| Pembaruan alokasi anggota | API-12, usulan di D2 |

Kontrak D2 membaca prediksi melalui ID dan belum menyediakan endpoint daftar observasi, estimasi, prediksi, atau panen aktual. Riwayat halaman ini di mode REST berasal dari hasil sesi aktif. ID observasi dan estimasi dapat disalin petani lalu dipakai koordinator sebagai referensi. Jika server belum menyediakan API-12, portal menampilkan status endpoint tersebut. API-01 mengirim unit `C` dan `percent` mengikuti fixture dataset v3. Impor CSV mengelompokkan pengukuran per kebun, komoditas, dan waktu sebelum mengirim JSON melalui API-01.

## Tampilan dan SF Symbols

Frontend memakai palet merek dan skala spacing Figma. Hijau grafik diturunkan dari warna merek. Merah merek menandai kekurangan pasokan dan kesalahan. Baskervville dipakai pada judul halaman dan angka prediksi utama. Figtree dipakai pada kontrol, label, dan angka yang dibandingkan di grafik. Kedua font disertakan lewat Fontsource.

Untuk melihat SF Symbols asli di macOS 13.3+, jalankan Vite di terminal pertama dan ini di terminal kedua dari `frontend/`.

```sh
npm run native
```

Host macOS merender SF Symbols asli melalui AppKit. Browser dan host yang tidak dapat memuat simbol tertentu memakai ikon Lucide yang setara. Ikon Lucide disertakan langsung di build sebagai SVG. Lisensinya tercantum di `dist/third-party-licenses.md`.

Jika port Vite berubah, jalankan dengan `SMARTHARVEST_URL=http://127.0.0.1:PORT npm run native`.

## Alur simulasi

1. Sebagai petani, kirim observasi manual, coba impor `contoh-observasi.csv`, atau kirim pembacaan berlabel Simulator IoT.
2. Sebagai koordinator, buka prediksi Bayam atau buat prediksi dari ID observasi dan estimasi. Bandingkan 12,4 kg dengan kebutuhan 15 kg untuk melihat potensi kekurangan.
3. Publikasikan ketersediaan Bayam dan ganti ke anggota Paket Pilih untuk mengirim pilihan. Anggota paket reguler dapat membaca daftar resmi.
4. Catat panen aktual sebagai koordinator, sesuaikan alokasi, dan buka pembaruannya sebagai anggota yang dituju. Umpan balik di periode demo memakai status paket contoh yang sudah diterima.

Mode simulasi memakai data contoh dan respons prediksi tetap. Untuk menguji inferensi AI dan data sensor sesungguhnya, jalankan integrasi bersama backend tim dan perangkat atau adapter IoT.
