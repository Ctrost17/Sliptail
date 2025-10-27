// src/lib/directDownload.ts
// iOS-safe direct download helper. Opens signed URL in a new tab so Safari/Files handles the transfer.


export function directDownload(href: string) {
const a = document.createElement("a");
a.href = href;
a.target = "_blank"; // iOS: avoid history issues and allow Files app takeover
a.rel = "noopener";
document.body.appendChild(a);
a.click();
a.remove();
}