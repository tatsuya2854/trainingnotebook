// index.html などを www/ にコピーする。Capacitor（iOS）と Worker の静的配信は www/ を見る。
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
mkdirSync("www", { recursive: true });
for (const f of ["index.html", "privacy.html", "terms.html"]) {
  if (existsSync(f)) copyFileSync(f, "www/" + f);
}
writeFileSync("www/.gitkeep", "");
console.log("www/ を更新しました");
