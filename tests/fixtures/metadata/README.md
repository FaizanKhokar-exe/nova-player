# Metadata test fixtures

Tiny (< 25 KB) deterministic audio files used by the Phase 2D/2E tests. They
were generated once with ffmpeg and are committed as-is; tests never invoke
ffmpeg. Regenerate only if a test needs a new shape.

| File | What it exercises |
| --- | --- |
| `full-tags.mp3` | Every mapped tag (title, artist, album, album artist, genre, track 3/12, disc 2/2, year 1999) plus an embedded PNG cover |
| `unicode-tags.flac` | Unicode title/artist/album (CJK, accents, emoji) in Vorbis comments |
| `No Tags Artist - No Tags Title.mp3` | No tags at all; the *file name* carries artist and title (domain filename fallback) |
| `Partial Tags.mp3` | Title tag only (no artist) |
| `formats-sample.{ogg,opus,m4a,aac,wav}` | One parseable file per supported extension (`.aac` has no duration: raw ADTS) |

Commands (ffmpeg 6+; `SRC="-f lavfi -t 0.5 -i anullsrc=r=22050:cl=mono"`):

```
ffmpeg -y $SRC -i cover.png -map 0:a -map 1:v -c:a libmp3lame -b:a 32k -c:v png -id3v2_version 3 \
  -metadata title="Full Tags Song" -metadata artist="The Tagged Artist" -metadata album="Album Name" \
  -metadata album_artist="Various Artists" -metadata genre="Rock" -metadata track="3/12" \
  -metadata disc="2/2" -metadata date="1999" full-tags.mp3
ffmpeg -y $SRC -c:a flac -metadata title="夜に駆ける – Ünïcödé 🎵" -metadata artist="YOASOBI" \
  -metadata album="THE BOOK" -metadata genre="J-Pop" -metadata tracknumber=1 unicode-tags.flac
ffmpeg -y $SRC -c:a libmp3lame -b:a 32k -map_metadata -1 -write_xing 0 -id3v2_version 0 \
  "No Tags Artist - No Tags Title.mp3"
ffmpeg -y $SRC -c:a libmp3lame -b:a 32k -id3v2_version 3 -metadata title="Only A Title" "Partial Tags.mp3"
```
