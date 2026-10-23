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

قبل النشر، تأكد أن `kv_namespaces[0].id` في `wrangler.jsonc` هو معرّف الـ KV namespace الخاص بحسابك (المعرّف الموجود حاليًا يخص إعدادك الحالي). وأبقِ binding باسم `AI` فقط إذا أردت استخدام Workers AI وكان متاحًا لحسابك.

ملاحظة: بعد النشر، افتح التطبيق من الهاتف وأعد تحميله مرة أو مرتين حتى يتحدّث الـ Service Worker إلى النسخة الجديدة (`agent-shell-v2`).
