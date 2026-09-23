# KKTC GSYİH Ekonometrik Tahmin Dashboard'u (GitHub Pages)

Bu proje, Kuzey Kıbrıs Türk Cumhuriyeti (KKTC) için geliştirilen bilimsel ekonometrik **ARDL (Auto-Regressive Distributed Lag)** GSYİH tahmin modelini interaktif bir web dashboard'u olarak sunar.

Sistem tamamen **statik web teknolojileri (HTML5, Vanilla JavaScript, CSS3, Chart.js)** ile hazırlanmış olup hiçbir backend sunucu veya derleme (build) adımı gerektirmez. Doğrudan **GitHub Pages** üzerinde çalışır.

---

## 🚀 GitHub Pages Üzerinde 2 Dakikada Yayınlama

Bu projeyi GitHub Pages'te hemen yayına almak için:

### Yöntem 1: Git ile Yükleme
```bash
cd kktc-gdp-dashboard
git init
git add .
git commit -m "feat: KKTC GDP Forecasting Dashboard"
git branch -M main
git remote add origin https://github.com/<kullanici-adiniz>/<repo-adiniz>.git
git push -u origin main
```

### Yöntem 2: GitHub Web Üzerinden Sürükle-Bırak
1. GitHub'da yeni bir public repository açın (örneğin `kktc-gdp-model`).
2. Bu klasördeki (`index.html`, `styles.css`, `app.js`, `model_data.js`) dosyalarını tarayıcı üzerinden repository'ye yükleyin.
3. Repository ana sayfasına dosyaları commit edin.

### GitHub Pages'i Aktif Etme:
1. Repository sayfanızda **Settings (Ayarlar)** sekmesine tıklayın.
2. Sol menüden **Pages** seçeneğine gelin.
3. **Build and deployment** başlığı altında:
   - **Source:** `Deploy from a branch`
   - **Branch:** `main` ve `/ (root)` seçin.
4. **Save** butonuna tıklayın. 1-2 dakika içinde siteniz `https://<kullanici-adiniz>.github.io/<repo-adiniz>/` adresinde yayında olacaktır!

---

## 📊 Model Mimarisi & Bilimsel Metodoloji

1. **Ana Model: ARDL (Auto-Regressive Distributed Lag)**
   - GSYİH'nin zaman serisi momentumunu yakalamak için bir önceki yılın reel GSYİH'si ($t-1$ gecikmesi) modele dahil edilmiştir.
   - **Leave-One-Out Çapraz Doğrulama (LOO-CV) MAPE:** `%2.83` (En düşük hata oranına sahip model).
   - **2024 Gerçekleşen Validasyon Hatası:** `-%0.94` (En başarılı tek model).

2. **Fiyat Deflatörü Tahmin Modeli:**
   - KKTC ekonomik verilerinde cari değerlerin reelleştirilmesi kritik olduğundan, deflatör iki bağımsız makro göstergeyle ekonometrik regresyon üzerinden tahmin edilir:
     $$\Delta \text{Deflatör}_t = 7.9407 + 0.2558 \times \text{USDTRYchg}_t + 0.5954 \times \text{CPIchg}_t \quad (R^2 = 0.87)$$
   - Alternatif olarak kullanıcı `%40 Kur + %60 TÜFE` basit formülünü veya doğrudan özel bir deflatör değerini seçebilir.

3. **Reel Değer Dönüşümü:**
   - Modele cari (nominal TL) olarak girilen Kamu Harcamaları (`PubSPEN`), Mevduatlar (`DEPOSIT`), İthalat (`IMP`) ve Krediler (`KREDI`) anında hesaplanan deflatöre bölünerek 1977 sabit fiyatlarına dönüştürülür:
     $$\text{Reel77} = \frac{\text{Cari Değer (TL)}}{\text{Deflatör}}$$

---

## 🎛️ Girdi Değişkenleri (Input Variables)

| Değişken | Açıklama | Birim / Format |
|---|---|---|
| **Hedef Yıl** | Tahmin yapılacak yıl | Yıl (Örn: 2025, 2026) |
| **CPIchg** | Yıllık Tüketici Fiyat Endeksi (Enflasyon) Değişimi | Yüzde (%) |
| **USDTRYchg** | Yıllık Ortalama USD/TRY Kur Değişimi | Yüzde (%) |
| **POP** | KKTC De Facto / Projeksiyon Nüfusu | Kişi |
| **ElectricKwH** | Toplam Yıllık Elektrik Tüketimi (GSYİH ile korelasyon: +0.97) | Milyon kWh |
| **DummyCorona** | Pandemi gibi olağanüstü dışsal şok kukla değişkeni | `0` (Normal) veya `1` (Şok) |
| **PubSPEN** | Yıllık Cari Kamu Harcamaları | Cari TL |
| **DEPOSIT** | Bankacılık Sektörü Toplam Cari Mevduatları | Cari TL |
| **IMP** | Toplam Cari İthalat | Cari TL |
| **KREDI** | Bankacılık Sektörü Toplam Cari Kredileri | Cari TL |

---

## 🎨 Tasarım Sistemi (Cal.com Inspired)
- **Monokromatik ve Fonksiyonel Estetik:** Paper `#f4f4f4`, Card White `#ffffff`, Ink `#101010`, Silver `#e5e7eb` sınırları.
- **Tipografi:** Cal Sans & Inter, yüksek okunabilirlik ve teknik hassasiyet.
- **Kart Mimarisi:** 12px border radius, 0px 4px 8px difüz gölgeler.
- **Gereksiz Renk Karmaşasından Arındırılmış:** Renk sadece anlamlı pozitif/negatif büyüme göstergelerinde ve Action Blue (`#0099ff`) vurgularında kullanılır.
