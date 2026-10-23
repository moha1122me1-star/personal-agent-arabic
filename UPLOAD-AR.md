# تعليمات رفع ملفات الوكيل من الهاتف

هذه نسخة مسطّحة لتجنب مشكلة مجلد `public`: ملفات الواجهة موجودة في جذر المستودع بجانب `build.mjs` و`package.json`.

## الملفات التي ترفعها إلى جذر مستودع GitHub
- `worker-source.js`
- `index.html`
- `app.js`
- `app.css`
- `sw.js`
- `manifest.webmanifest`
- `icon.svg`
- `build.mjs`
- `package.json`
- `wrangler.jsonc`
- `README-AR.md`
- `UPLOAD-AR.md` (اختياري)

ارفع الملفات إلى الصفحة الرئيسية للمستودع (Root)، وليس داخل مجلد. إذا كانت ملفات بنفس الاسم موجودة، استبدلها بالنسخ الموجودة في هذه الحزمة، ولا تحذف أي ملفات أخرى غير مرتبطة.

`dist/worker.js` يُنشأ تلقائيًا عند تشغيل `npm run build`؛ لا تحتاج إلى رفع مجلد `dist` يدويًا.

## إعداد Cloudflare Builds
- Root directory: فارغ / جذر المستودع (المكان الذي توجد فيه `build.mjs` و`package.json`).
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

قبل النشر، افتح `wrangler.jsonc` واستبدل `REPLACE_WITH_YOUR_KV_ID` بمعرّف KV namespace الحقيقي. لا تستخدم معرّفًا تخمينيًا. وأضف binding باسم `AI` فقط إذا أردت استخدام Workers AI وكان متاحًا لحسابك.
