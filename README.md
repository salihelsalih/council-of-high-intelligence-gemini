# Council of High Intelligence — Gemini Sürümü

<p align="center">
  <img src="assets/header.jpeg" alt="Council of High Intelligence" width="800">
</p>

<p align="center">
  18 yapay zeka karakteri en zor kararlarınızı birden fazla Gemini modeliyle tartışır. Tek komut.
</p>

<p align="center">
  <a href="https://github.com/salihelsalih/council-of-high-intelligence-gemini/releases"><img src="https://img.shields.io/github/v/release/salihelsalih/council-of-high-intelligence-gemini" alt="Release"></a>
  <a href="https://github.com/salihelsalih/council-of-high-intelligence-gemini/stargazers"><img src="https://img.shields.io/github/stars/salihelsalih/council-of-high-intelligence-gemini" alt="Stars"></a>
  <img src="https://img.shields.io/badge/API-Google%20Gemini-blue" alt="Gemini API">
  <img src="https://img.shields.io/badge/Üyeler-18-orange" alt="18 Üye">
  <img src="https://img.shields.io/badge/Mod-Quick%20%7C%20Duo%20%7C%20Full-gold" alt="Modlar">
</p>

---

> **Orijinal proje:** [0xNyk/council-of-high-intelligence](https://github.com/0xNyk/council-of-high-intelligence) — Bu repo, orijinal projenin Google Gemini API'ye tam geçişini ve web arayüzü entegrasyonunu içeren fork'udur. Orijinal çalışmanın tüm hakkı [0xNyk](https://github.com/0xNyk)'ye aittir.

---

## Hızlı Başlangıç

```bash
git clone https://github.com/salihelsalih/council-of-high-intelligence-gemini.git
cd council-of-high-intelligence-gemini
npm install
```

`.env` dosyası oluştur:

```env
GEMINI_API_KEY=buraya_api_anahtarını_yaz
```

Sunucuyu başlat:

```bash
npm start
```

Tarayıcıda aç: **http://localhost:3131**

---

## Bu Fork'ta Yapılan Değişiklikler

### 1. Anthropic → Google Gemini API Geçişi
Orijinal proje Claude Code skill olarak çalışıyordu. Bu fork, tüm AI çağrılarını **Google Gemini API**'ye taşıdı. Hiçbir Anthropic/Claude bağımlılığı kalmadı.

### 2. 12 Modelli Otomatik Yedekleme Sistemi
Quota, rate limit veya 404 hatası alındığında sistem otomatik olarak sıradaki modele geçer. 30 dakikalık cooldown sonrası devre dışı kalan modeller yeniden denenir.

### 3. Web Arayüzü (Tarayıcı Tabanlı)
Claude Code CLI yerine doğrudan tarayıcıdan kullanılabilen tam özellikli bir arayüz geliştirildi:
- Gerçek zamanlı SSE (Server-Sent Events) ile anlık sonuç akışı
- Renk kodlu tur rozetleri (Mavi → Kırmızı → Yeşil → Altın)
- Markdown render desteği

### 4. Full Mod Implementasyonu (7 Adım)
Orijinal projede `// not yet` yorumuyla kapalı olan Full mod tamamen implement edildi:

| Adım | İşlem |
|------|-------|
| 1 | Provider yönlendirme |
| 2 | **Problem Restate Gate** — her üye soruyu kendi çerçevesinden yeniden tanımlar |
| 3 | **Round 1** — Bağımsız derin analiz (200 kelime) |
| 4 | **Round 2** — Çapraz sorgu — en az 2 üyeye meydan okuma (150 kelime) |
| 5 | **Enforcement Scan** — Groupthink ve erken uzlaşma kontrolü |
| 6 | **Round 3** — Final kristalizasyon (60 kelime) |
| 7 | **Karar Sentezi** — Cevapsız sorular önce gelir |

### 5. Düşünce Sızıntısı Düzeltmesi
`gemini-2.5-flash` gibi thinking modelleri iç muhakemelerini yanıta dahil ediyordu. İki katmanlı çözüm uygulandı:
- `thinkingBudget: 0` ile thinking devre dışı (destekleyen modellerde)
- `candidates[0].content.parts` manuel filtresi ile `thought: true` kısımlar yanıttan çıkarıldı

### 6. Türkçe Dil Zorunluluğu
Tüm prompt'lara zorunlu dil kuralı eklendi. Soru Türkçeyse yanıt, verdict dahil, tamamen Türkçe üretilir.

### 7. Hata Yönetimi İyileştirmeleri
- 500 Internal Server Error → geçici atlama (quota hatası gibi muamele)
- 400 Bad Request (thinkingConfig desteklenmiyor) → model bazlı kontrol
- 404 Not Found → kalıcı olarak o modeli devre dışı bırakma

---

## Desteklenen Google Gemini Modelleri

Sistem aşağıdaki modeller arasında öncelik sırasına göre otomatik geçiş yapar:

| Sıra | Model | Açıklama |
|------|-------|----------|
| 1 | `gemini-2.5-flash` | **Birincil model** — en yüksek kalite, thinking desteği |
| 2 | `gemini-3-flash-preview` | Gemini 3 Flash önizleme |
| 3 | `gemini-flash-latest` | En güncel Flash alias |
| 4 | `gemini-flash-lite-latest` | Lite alias |
| 5 | `gemini-2.5-flash-lite` | 2.5 Lite sürümü |
| 6 | `gemini-2.0-flash` | Kararlı 2.0 Flash |
| 7 | `gemini-2.0-flash-lite` | 2.0 Lite |
| 8 | `gemma-4-31b-it` | Gemma 4 31B açık model |
| 9 | `gemma-4-26b-a4b-it` | Gemma 4 26B MoE |
| 10 | `gemini-3.1-flash-lite` | 3.1 Flash Lite |
| 11 | `gemini-3.1-flash-lite-preview` | 3.1 Flash Lite önizleme |
| 12 | `gemini-3-pro-preview` | Son çare — Pro (yavaş) |

---

## Konsey Üyeleri (18 Karakter)

| Üye | Karakter | Alan |
|-----|----------|------|
| `council-aristotle` | Aristoteles | Sınıflandırma ve yapı |
| `council-socrates` | Sokrates | Varsayımları yıkma |
| `council-sun-tzu` | Sun Tzu | Çatışma stratejisi |
| `council-ada` | Ada Lovelace | Formal sistemler |
| `council-aurelius` | Marcus Aurelius | Dayanıklılık ve ahlaki netlik |
| `council-machiavelli` | Machiavelli | Güç dinamikleri |
| `council-lao-tzu` | Lao Tzu | Eylem-dışılık ve oluşum |
| `council-feynman` | Feynman | Birinci prensiplerden başlama |
| `council-torvalds` | Linus Torvalds | Pragmatik mühendislik |
| `council-musashi` | Miyamoto Musashi | Stratejik zamanlama |
| `council-watts` | Alan Watts | Perspektif ve yeniden çerçeveleme |
| `council-karpathy` | Andrej Karpathy | Ampirik ML |
| `council-sutskever` | Ilya Sutskever | AI güvenliği ve ölçekleme |
| `council-kahneman` | Daniel Kahneman | Bilişsel önyargı |
| `council-meadows` | Donella Meadows | Sistem düşüncesi |
| `council-munger` | Charlie Munger | Çoklu model muhakemesi |
| `council-taleb` | Nassim Taleb | Antikırılganlık ve kuyruk riski |
| `council-rams` | Dieter Rams | Kullanıcı merkezli tasarım |

---

## Deliberasyon Modları

### ⚡ Quick Mod (2 Tur)
Hızlı kararlar için. Bağımsız analiz → Final pozisyonlar → Karar.

### ⚔️ Duo Mod (2 Üye)
İki zıt karakterin diyalektiği. Gerilimi keşfetmek için idealdir.

### 🏛️ Full Mod (7 Adım)
En derin analiz. Problem Restate Gate → 3 tur deliberasyon → Enforcement kontrolü → Karar sentezi.

---

## Gereksinimler

- **Node.js** v18+
- **Google Gemini API Anahtarı** → [aistudio.google.com](https://aistudio.google.com)

```bash
npm install        # Bağımlılıkları kur
npm start          # Sunucuyu başlat (port 3131)
```

---

## Lisans

[![CC0](https://licensebuttons.net/p/zero/1.0/88x31.png)](https://creativecommons.org/publicdomain/zero/1.0/)

Orijinal proje CC0 lisansıyla yayınlanmıştır. Bu fork da aynı lisansı taşımaktadır.

---

## Teşekkür

Bu projenin temeli [0xNyk](https://github.com/0xNyk) tarafından oluşturulmuştur.  
Orijinal repo: **[council-of-high-intelligence](https://github.com/0xNyk/council-of-high-intelligence)**

Bu fork; Google Gemini API entegrasyonu, web arayüzü, Full Mod implementasyonu ve Türkçe dil desteği eklemektedir.
