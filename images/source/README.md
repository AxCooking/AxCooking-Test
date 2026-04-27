# Source-Bilder für die Image-Pipeline

In diesem Ordner liegen die **Original-Bilder** (Source) für jedes Rezept. Die GitHub Action `Image Pipeline` erzeugt daraus automatisch die optimierten Varianten in `../optimized/`.

## Dateinamen-Konvention

Pro Rezept werden **bis zu drei** Source-Bilder unterstützt — alle mit der jeweiligen Recipe-ID als Präfix und einem Suffix für das Seitenverhältnis:

| Dateiname | Format | Pflicht? | Wofür wird es genutzt? |
|---|---|---|---|
| `recipe-id-16x9.jpg` | 16:9 (Querformat) | ✅ Ja | Detail-Hauptbild, Übersichtsliste, OG-Image, Legacy 800×450 |
| `recipe-id-43.jpg` | 4:3 (klassisch) | optional | 4:3-Output-Varianten, Square 1200×1200 |
| `recipe-id-pin.jpg` | 2:3 (Pinterest-Hochformat) | optional | Pinterest-Pin 1000×1500 |

**Beispiel** für das Rezept mit ID `spaghetti-bolognese-aus-eingekochter-sauce`:

```
spaghetti-bolognese-aus-eingekochter-sauce-16x9.jpg   ← Pflicht
spaghetti-bolognese-aus-eingekochter-sauce-43.jpg     ← optional, gibt schöneres 4:3-Crop
spaghetti-bolognese-aus-eingekochter-sauce-pin.jpg    ← optional, gibt schöneres Pinterest-Hochformat
```

## Was passiert wenn nur 16:9 hochgeladen wird?

Funktioniert problemlos. Die Pipeline nutzt Smart-Crop (Sharp `attention`-Algorithmus, der die "wichtigste" Bildregion erkennt) um aus dem 16:9-Source automatisch 4:3 und 2:3 zu schneiden. Ergebnis ist meist gut, in Einzelfällen kann es sein dass am Rand etwas Wichtiges abgeschnitten wird — dann kann jederzeit ein optionales `-43.jpg` oder `-pin.jpg` nachgereicht werden.

## Empfohlene Auflösungen

- **16:9**: mindestens 2400×1350, ideal 3200×1800 oder größer
- **4:3**: mindestens 2000×1500, ideal 2800×2100 oder größer
- **Pin (2:3)**: mindestens 1500×2250, ideal 2000×3000 oder größer

Sharp kann nur runter-, nicht hochskalieren. Lieber zu groß als zu klein.

## Format

- **JPG bevorzugt** für Foto-Inhalte
- **PNG** akzeptiert (selten sinnvoll für Foodfotos — größere Dateien ohne Qualitätsgewinn)
- EXIF-Rotation wird automatisch interpretiert
- ICC-Profile werden korrekt verarbeitet

## Inkrementelle Verarbeitung

Die Pipeline cached basierend auf SHA256-Hash. Wird ein Source-Bild geändert oder hinzugefügt, wird **nur dieses eine Rezept** neu encodiert — andere bleiben unangetastet.

## Wenn ein Rezept gelöscht wird

Lösche die Source-Files aus diesem Ordner. Die nächste Action räumt das Manifest auf (Orphan-Removal). Die optimierten Files in `../optimized/` bleiben aktuell stehen — sie können bei Bedarf manuell entfernt werden.
