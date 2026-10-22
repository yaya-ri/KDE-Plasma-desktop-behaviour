# KDE Plasma Desktop Behaviour

Kumpulan efek dan script KWin untuk KDE Plasma 6 yang membuat perilaku jendela dan desktop terasa seperti macOS:

| Fitur | Jenis | Fungsi |
|---|---|---|
| **tile-animation** | Efek KWin | Jendela bergerak halus (dengan crossfade) saat di-tile atau di-snap lewat `Meta + ←/→`, bukan loncat. |
| **maximize-desktop** | Script KWin | Jendela yang di-maximize (atau fullscreen) pindah ke desktop virtual baru di sebelah kanan dengan animasi geser, seperti *Spaces* di macOS. Saat dikembalikan ke ukuran biasa, animasi berbalik dan desktop barunya dihapus. |
| **per-monitor-desktops** | Script KWin | Tiap monitor punya desktop aktif sendiri. Menggeser desktop di satu monitor tidak ikut menggeser monitor lain (seperti *Displays have separate Spaces* di macOS). |

Semua fitur bisa dinyalakan dan dimatikan satu per satu, lewat terminal atau lewat System Settings.

> Diuji di **CachyOS**, **KDE Plasma 6.7.5**, sesi **Wayland**, dengan dua monitor. Distro lain dengan Plasma 6 (misalnya **KDE Neon**) seharusnya bisa dipakai, tapi belum diuji. Sesi X11 belum diuji.

---

## Persyaratan

- **KDE Plasma 6** (KWin 6). Plasma 5 tidak didukung.
- `kwriteconfig6` dan `kreadconfig6` (sudah ikut bersama Plasma 6).
- `qdbus6`, atau `busctl` (bawaan systemd). Installer memakai salah satunya.
- `bash` dan `git`.

## Instalasi

```bash
git clone https://github.com/yaya-ri/KDE-Plasma-desktop-behaviour.git
cd KDE-Plasma-desktop-behaviour

./install.sh install                                   # memasang file, belum mengaktifkan apa pun
./install.sh enable tile-animation maximize-desktop    # aktifkan fitur yang aman
```

`install` menaruh file di `~/.local/share/kwin/` dan memasang perintah pengatur `kde-desktop-behaviour` di `~/.local/bin/`. Tidak perlu `sudo`, tidak perlu login ulang, dan tidak perlu me-restart KWin.

Kalau perintah `kde-desktop-behaviour` belum dikenali, login ulang sekali (supaya `~/.local/bin` masuk `PATH`), atau jalankan dengan path lengkap: `~/.local/bin/kde-desktop-behaviour`.

Fitur **per-monitor-desktops** sengaja tidak ikut dalam contoh di atas. Fitur ini paling invasif, jadi baca dulu bagian [per-monitor-desktops](#per-monitor-desktops) sebelum mengaktifkannya.

## Menyalakan dan mematikan

### Lewat terminal

```bash
kde-desktop-behaviour status                         # lihat fitur mana yang terpasang / aktif
kde-desktop-behaviour enable  tile-animation         # nyalakan satu fitur
kde-desktop-behaviour disable tile-animation         # matikan satu fitur
kde-desktop-behaviour enable  all                    # nyalakan semuanya
kde-desktop-behaviour disable all                    # matikan semuanya
```

Nama fitur: `tile-animation`, `maximize-desktop`, `per-monitor-desktops`.
(Dari folder repo, ganti `kde-desktop-behaviour` dengan `./install.sh`.)

### Lewat System Settings

| Fitur | Lokasi |
|---|---|
| tile-animation | **System Settings → Window Management → Desktop Effects**, cari **Tile Animation**, lalu centang atau hilangkan centangnya. Ikon gear membuka pengaturannya. |
| maximize-desktop | **System Settings → Window Management → KWin Scripts**, centang **Maximize to New Desktop**, lalu **Apply**. Tombol konfigurasi membuka pengaturan pemicu. |
| per-monitor-desktops | **System Settings → Window Management → KWin Scripts**, centang **Separate Desktops per Monitor**, lalu **Apply**. **Mematikannya sebaiknya lewat terminal**, lihat catatan di bawah. |

## Detail tiap fitur

### tile-animation

Saat jendela berubah ukuran karena quick-tile (`Meta + ←/→`, drag ke tepi layar, dan sejenisnya), jendela meluncur dan membesar atau mengecil dengan mulus. Isi jendela lama dan baru di-crossfade.

Pengaturan (ikon gear di Desktop Effects):

- **Duration**: durasi animasi, default 300 ms. Durasi juga mengikuti slider *Animation Speed* global KDE.
- **Cross-fade**: menyatukan tampilan lama dan baru dengan halus.
- **Only animate tiled/snapped windows**: kalau dimatikan, setiap perubahan ukuran jendela ikut dianimasikan.

Catatan: efek KWin tidak bisa tahu apakah perubahan ukuran berasal dari tiling. Efek ini menebak jendela "ter-snap" jika sisinya menempel ke minimal dua tepi layar (toleransi 80 px). Perubahan ukuran oleh aplikasi sendiri di dekat tepi layar kadang ikut teranimasi. Animasi maximize tetap ditangani efek **Stretch** bawaan KDE.

### maximize-desktop

Seperti tombol hijau di macOS. Saat sebuah jendela di-maximize:

1. desktop virtual baru dibuat tepat di kanan desktop asal jendela;
2. jendela dipindah ke sana dan tampilan bergeser ke desktop itu.

Saat jendela dikembalikan ke ukuran biasa:

1. jendela kembali ke desktop asalnya dan tampilan ikut kembali;
2. desktop yang tadi dibuat dihapus (setelah animasi selesai).

Animasi gesernya berasal dari efek **Slide** bawaan KDE (System Settings → Desktop Effects → *Slide*). Pastikan efek itu aktif.

Pengaturan (tombol konfigurasi di KWin Scripts): pemicunya bisa **Maximized** (default), **Made fullscreen**, atau **Maximized or fullscreen**. Tombol hijau macOS sebenarnya lebih mirip fullscreen, jadi pilih sesuai selera.

Jendela dan desktop bergerak **bersamaan**: jendela meregang sambil desktop bergeser, seperti di macOS. Kalau terasa terlalu cepat, lihat [Mengatur kecepatan animasi](#mengatur-kecepatan-animasi).

Perilaku tambahan:

- Jendela yang ditutup saat sedang maximize: desktopnya dihapus dan tampilan kembali.
- Jendela yang kamu pindahkan sendiri ke desktop lain: dilepas dari script ini, dan desktop kosongnya dihapus.
- Jendela yang sudah maximize saat dibuka atau saat sesi dipulihkan tidak dipindahkan (ada jeda 1,5 detik).
- Dialog dan jendela "on all desktops" diabaikan.

Catatan: setiap maximize lewat double-click title bar atau `Meta + ↑` akan membuat desktop baru. Kalau itu mengganggu, ganti pemicunya ke *fullscreen*.

### per-monitor-desktops

Pada KDE biasa, desktop virtual bersifat global. Kalau kamu menggeser dari Desktop 1 ke Desktop 2, semua monitor ikut berpindah. Fitur ini membuat tiap monitor punya desktop aktif sendiri.

**Cara kerja.** KWin hanya punya satu desktop aktif global, jadi perilaku ini ditiru:

- Monitor aktif (tempat kursor atau jendela aktif berada) memakai mekanisme desktop asli KDE, jadi animasi Slide bawaan tetap dipakai.
- Di monitor lain, jendela yang sedang tampil dijadikan "on all desktops" supaya tidak ikut bergeser. Jendela milik desktop lain di-minimize oleh script.
- Saat kursor atau fokus pindah ke monitor lain, peran "monitor aktif" ikut pindah.

**Hal yang perlu kamu tahu:**

- Jendela yang disembunyikan tampil sebagai jendela ter-minimize di taskbar. Mengklik jendela itu membawa monitornya ke desktop jendela tersebut.
- Jendela yang kamu seret ke monitor lain ikut desktop yang sedang tampil di monitor itu.
- Jumlah desktop tetap global. Desktop baru muncul di semua monitor.
- Jendela **ter-tile** yang terlihat di monitor lain tetap di posisinya, tapi "ukuran bebas sebelum di-tile" miliknya tertimpa. Kalau nanti di-drag keluar dari tile, ukurannya tetap sebesar tile. Ini batasan KWin: tile menempel pada satu desktop.
- Kalau monitor dicabut, jendela yang tersembunyi di sana muncul di monitor yang tersisa.
- Dialog dan jendela khusus tidak dikelola.
- Perpindahan monitor aktif lewat kursor dicek tiap 100 ms.

**Cara mematikan yang aman.** Script ini mengubah status jendela (on all desktops / minimize). Kalau dimatikan hanya dengan menghilangkan centang di System Settings, jendela bisa tertinggal berstatus "on all desktops" atau ter-minimize. Karena itu matikan lewat:

```bash
kde-desktop-behaviour disable per-monitor-desktops
```

Perintah ini mengembalikan semua jendela ke perilaku normal KDE terlebih dulu, baru mematikan script.

Alternatifnya, di **System Settings → Keyboard → Shortcuts** (bagian *KWin*) ada shortcut **Per-monitor desktops: restore normal behavior**. Beri tombol, lalu tekan sebelum mematikan script.

Kalau jendela terlanjur tersembunyi: jalankan `kde-desktop-behaviour disable per-monitor-desktops`. Jendela yang hilang itu hanya ter-minimize, jadi masih bisa dipulihkan dari taskbar.

## Mengatur kecepatan animasi

Kalau animasi terasa terlalu cepat sampai tidak terlihat, ada beberapa tempat untuk mengaturnya, semuanya dari pengaturan KDE:

| Yang ingin diatur | Di mana |
|---|---|
| **Semua animasi sekaligus** (maximize, geser desktop, tile, dan lainnya) | System Settings, cari **Animation speed** (di Plasma 6: *Appearance & Style → Animations*). Geser slider ke arah *lambat*. Ini yang paling besar pengaruhnya, dan berlaku untuk semua efek. |
| Animasi tile | **Desktop Effects → Tile Animation → gear → Duration**. Nilainya dikalikan slider *Animation speed*. |
| Animasi regang jendela saat maximize | Efek **Stretch** bawaan KDE, tidak punya pengaturan sendiri. Hanya mengikuti slider *Animation speed*. |
| Animasi geser desktop | Efek **Slide** bawaan KDE. Pengaturannya hanya jarak antar desktop, tidak ada durasi. Hanya mengikuti slider *Animation speed*. |

Slider *Animation speed* di bawah 100% memperpendek semua animasi. Kalau animasi terasa singkat, cek dulu slider itu.

## Mengatasi masalah

- **Efek tidak muncul di Desktop Effects / script tidak muncul di KWin Scripts.** Jalankan `kde-desktop-behaviour status`. Kalau kolom *TERPASANG* berisi "tidak", jalankan `install` lagi. Setelah itu buka ulang System Settings.
- **Fitur sudah "aktif" tapi tidak terasa.** Pastikan KWin berjalan di sesi yang sama. Cek log:
  ```bash
  journalctl --user -b | grep -E 'kwin_(wayland|x11)' | tail -30
  ```
  Kesalahan script tampil sebagai `TypeError` atau `ReferenceError` dengan nama file `main.js`.
- **Log debug per-monitor-desktops.** Ubah `const DEBUG = false;` menjadi `true` di `~/.local/share/kwin/scripts/permonitordesktops/contents/code/main.js`, matikan lalu nyalakan fitur lagi, lalu pantau:
  ```bash
  journalctl --user -b -f | grep permonitordesktops
  ```
- **`kwriteconfig6: command not found`.** Pasang paket yang menyediakan `kwriteconfig6` (bagian dari KDE Frameworks 6 / `kconfig`). Kalau itu tidak ada, Plasma 6 belum terpasang di sistemmu.

## Menghapus

```bash
kde-desktop-behaviour uninstall            # nonaktifkan lalu hapus semua fitur
kde-desktop-behaviour uninstall tile-animation   # atau hanya satu fitur
```

## Struktur repo

```
install.sh                       installer dan pengatur on/off
effects/tileanimation/           efek KWin: tile-animation
scripts/spacemaximize/           script KWin: maximize-desktop
scripts/permonitordesktops/      script KWin: per-monitor-desktops
```

Setiap folder adalah paket KWin standar (`metadata.json` + `contents/`), jadi bisa juga dipasang manual dengan menyalinnya ke `~/.local/share/kwin/effects/` atau `~/.local/share/kwin/scripts/`.

## Lisensi

[GPL-2.0-or-later](LICENSE).
