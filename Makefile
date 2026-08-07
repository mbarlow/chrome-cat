VERSION := $(shell grep -oP '"version": "\K[^"]+' manifest.json)

# Pinned vendor versions — bump here, re-run `make vendor`, commit the diff.
TESS_VER := 6.0.1
CORE_VER := 6.0.0
CDN      := https://cdn.jsdelivr.net/npm

.PHONY: help install icons vendor smoke repo package clean

help:
	@echo "chrome-chat v$(VERSION) — commands"
	@echo ""
	@echo "  make install   - how to load the unpacked extension in Chrome"
	@echo "  make icons     - regenerate PNG icons from icons/icon.svg"
	@echo "  make vendor    - fetch pinned Tesseract.js files into vendor/tesseract/"
	@echo "  make smoke     - headless boot + OCR + IDB smoke test (needs global playwright)"
	@echo "  make repo      - git init + create private GitHub repo mbarlow/chrome-chat"
	@echo "  make package   - create a versioned .zip for distribution"
	@echo "  make clean     - remove build artifacts"

install:
	@echo "1. Open chrome://extensions/"
	@echo "2. Enable 'Developer mode'"
	@echo "3. 'Load unpacked' -> $(PWD)"

icons:
	@rsvg-convert -w 16  -h 16  icons/icon.svg -o icons/icon16.png
	@rsvg-convert -w 32  -h 32  icons/icon.svg -o icons/icon32.png
	@rsvg-convert -w 48  -h 48  icons/icon.svg -o icons/icon48.png
	@rsvg-convert -w 128 -h 128 icons/icon.svg -o icons/icon128.png
	@echo "Icons regenerated."

vendor:
	@mkdir -p vendor/tesseract/lang
	@echo "Fetching tesseract.js@$(TESS_VER) + core@$(CORE_VER) ..."
	@curl -fsSL $(CDN)/tesseract.js@$(TESS_VER)/dist/tesseract.min.js -o vendor/tesseract/tesseract.min.js
	@curl -fsSL $(CDN)/tesseract.js@$(TESS_VER)/dist/worker.min.js -o vendor/tesseract/worker.min.js
	@curl -fsSL $(CDN)/tesseract.js-core@$(CORE_VER)/tesseract-core-simd-lstm.wasm.js -o vendor/tesseract/tesseract-core-simd-lstm.wasm.js
	@curl -fsSL $(CDN)/tesseract.js-core@$(CORE_VER)/tesseract-core-simd-lstm.wasm -o vendor/tesseract/tesseract-core-simd-lstm.wasm
	@curl -fsSL $(CDN)/tesseract.js-core@$(CORE_VER)/tesseract-core-lstm.wasm.js -o vendor/tesseract/tesseract-core-lstm.wasm.js
	@curl -fsSL $(CDN)/tesseract.js-core@$(CORE_VER)/tesseract-core-lstm.wasm -o vendor/tesseract/tesseract-core-lstm.wasm
	@curl -fsSL https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz -o vendor/tesseract/lang/eng.traineddata.gz
	@printf "tesseract.js %s\ntesseract.js-core %s\ntessdata 4.0.0_fast eng\n" "$(TESS_VER)" "$(CORE_VER)" > vendor/tesseract/VERSION
	@ls -lh vendor/tesseract/ vendor/tesseract/lang/
	@echo "Vendored. Commit the diff."

smoke:
	@node tools/smoke.mjs

repo:
	@test -d .git || git init -b main
	@gh repo create mbarlow/chrome-chat --private --source=. --push || echo "repo exists or push failed — check gh output"

package: clean
	@zip -r chrome-chat-$(VERSION).zip \
		manifest.json src vendor icons \
		README.md LICENSE \
		-x "*.DS_Store"
	@echo "Packaged chrome-chat-$(VERSION).zip"

clean:
	@rm -f chrome-chat-*.zip
	@echo "Clean."
