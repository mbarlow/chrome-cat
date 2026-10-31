VERSION := $(shell grep -oP '"version": "\K[^"]+' manifest.json)

# Pinned vendor versions — bump here, re-run `make vendor`, commit the diff.
TESS_VER := 6.0.1
CORE_VER := 6.0.0
TESSDATA := 4.0.0_fast
CDN      := https://cdn.jsdelivr.net/npm

# Everything `make vendor` fetches — the exact set SHA256SUMS locks.
# NOTICE, VERSION and SHA256SUMS itself are ours, so they're not in the list.
VENDOR_FILES := \
	tesseract.min.js \
	tesseract.min.js.LICENSE.txt \
	worker.min.js \
	worker.min.js.LICENSE.txt \
	tesseract-core-lstm.wasm \
	tesseract-core-lstm.wasm.js \
	tesseract-core-simd-lstm.wasm \
	tesseract-core-simd-lstm.wasm.js \
	lang/eng.traineddata.gz \
	LICENSE-APACHE-2.0.txt

.PHONY: help install icons vendor vendor-lock vendor-verify smoke e2e repo package clean

help:
	@echo "chrome-cat v$(VERSION) — commands"
	@echo ""
	@echo "  make install   - how to load the unpacked extension in Chrome"
	@echo "  make icons     - regenerate PNG icons from icons/icon.svg"
	@echo "  make vendor    - fetch pinned Tesseract.js files into vendor/tesseract/"
	@echo "  make vendor-verify - check vendor/tesseract against SHA256SUMS"
	@echo "  make vendor-lock   - regenerate SHA256SUMS from what's on disk"
	@echo "  make smoke     - headless boot + OCR + IDB smoke test (needs global playwright)"
	@echo "  make e2e       - real Chrome + Gemini Nano: scan a fixture, chat through the panel"
	@echo "  make repo      - git init + create private GitHub repo mbarlow/chrome-cat"
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
	@curl -fsSL https://tessdata.projectnaptha.com/$(TESSDATA)/eng.traineddata.gz -o vendor/tesseract/lang/eng.traineddata.gz
	@echo "Fetching upstream license texts ..."
	@curl -fsSL $(CDN)/tesseract.js@$(TESS_VER)/dist/tesseract.min.js.LICENSE.txt -o vendor/tesseract/tesseract.min.js.LICENSE.txt
	@curl -fsSL $(CDN)/tesseract.js@$(TESS_VER)/dist/worker.min.js.LICENSE.txt -o vendor/tesseract/worker.min.js.LICENSE.txt
	@curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o vendor/tesseract/LICENSE-APACHE-2.0.txt
	@printf "tesseract.js %s\ntesseract.js-core %s\ntessdata %s eng\n" "$(TESS_VER)" "$(CORE_VER)" "$(TESSDATA)" > vendor/tesseract/VERSION
	@if [ -f vendor/tesseract/SHA256SUMS ]; then \
		echo "Verifying against SHA256SUMS ..."; \
		cd vendor/tesseract && sha256sum -c --quiet SHA256SUMS || { \
			echo ""; \
			echo "!! Fetched bytes differ from SHA256SUMS."; \
			echo "!! If you bumped a pinned version on purpose: make vendor-lock"; \
			echo "!! If you did not: upstream changed under a pinned version. Stop and look."; \
			exit 1; }; \
	else \
		$(MAKE) --no-print-directory vendor-lock; \
	fi
	@ls -lh vendor/tesseract/ vendor/tesseract/lang/
	@echo "Vendored and verified. Commit the diff."

# Re-lock after an intentional version bump. Locks whatever is on disk —
# only run this when you know the bytes are the ones you meant to ship.
vendor-lock:
	@cd vendor/tesseract && sha256sum $(VENDOR_FILES) > SHA256SUMS
	@echo "Locked $(words $(VENDOR_FILES)) files into vendor/tesseract/SHA256SUMS."

# Standalone integrity check. Fails loud, no network.
vendor-verify:
	@test -f vendor/tesseract/SHA256SUMS || { echo "No vendor/tesseract/SHA256SUMS — run 'make vendor'."; exit 1; }
	@cd vendor/tesseract && sha256sum -c --quiet SHA256SUMS
	@echo "vendor/tesseract: $(words $(VENDOR_FILES)) files match SHA256SUMS."

smoke: vendor-verify
	@node tools/smoke.mjs

e2e: vendor-verify
	@node tools/e2e.mjs

repo:
	@test -d .git || git init -b main
	@gh repo create mbarlow/chrome-cat --private --source=. --push || echo "repo exists or push failed — check gh output"

package: clean vendor-verify
	@zip -r chrome-cat-$(VERSION).zip \
		manifest.json src vendor icons \
		README.md LICENSE \
		-x "*.DS_Store"
	@echo "Packaged chrome-cat-$(VERSION).zip"

clean:
	@rm -f chrome-cat-*.zip
	@echo "Clean."
