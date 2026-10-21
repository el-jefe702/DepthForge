import fs from 'fs';
import path from 'path';

const indexHtmlPath = path.join(process.cwd(), 'static', 'index.html');
const styleCssPath = path.join(process.cwd(), 'static', 'style.css');
const androidIndexHtmlPath = path.join(process.cwd(), 'android_app', 'app', 'src', 'main', 'assets', 'index.html');
const androidStyleCssPath = path.join(process.cwd(), 'android_app', 'app', 'src', 'main', 'assets', 'style.css');
const androidStaticStyleCssPath = path.join(process.cwd(), 'android_app', 'app', 'src', 'main', 'assets', 'static', 'style.css');

if (fs.existsSync(indexHtmlPath) && fs.existsSync(androidIndexHtmlPath)) {
    fs.copyFileSync(indexHtmlPath, androidIndexHtmlPath);
    console.log('Synced index.html to Android');
}
if (fs.existsSync(styleCssPath) && fs.existsSync(androidStyleCssPath)) {
    fs.copyFileSync(styleCssPath, androidStyleCssPath);
    console.log('Synced style.css to Android');
}
if (fs.existsSync(styleCssPath) && fs.existsSync(androidStaticStyleCssPath)) {
    fs.copyFileSync(styleCssPath, androidStaticStyleCssPath);
    console.log('Synced static/style.css to Android');
}
