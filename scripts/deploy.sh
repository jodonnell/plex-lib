git branch -D deploy
git checkout -b deploy
npm run build
mv dist/index.html .
rm -rf assets
cp -R dist/assets ./assets
cp dist/favicon.svg .
cp dist/styles.css .
git add index.html
git add assets
git add favicon.svg
git add styles.css
git commit -m "deploy commit"
git push origin deploy -f
rm -rf assetsbk
git checkout main
