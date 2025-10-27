// src/lib/directDownload.ts
// iOS-safe direct download helper that fetches with auth and triggers browser download.

import { loadAuth } from "./auth";

export async function directDownload(href: string) {
  try {
    // Get the auth token
    const auth = loadAuth();
    const token = auth?.token || null;
    
    // Make authenticated request - this will follow redirects automatically
    const response = await fetch(href, {
      method: "GET",
      credentials: "include", // include cookies
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "follow", // Follow redirects to get the final file
    });

    if (!response.ok) {
      // Try to get error message from response
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || `Download failed: ${response.status}`);
    }

    // Get the blob from the response
    const blob = await response.blob();
    
    // Extract filename from Content-Disposition header if available
    const contentDisposition = response.headers.get("Content-Disposition");
    let filename = "download";
    
    if (contentDisposition) {
      // Try to extract filename from Content-Disposition header
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1].replace(/['"]/g, '');
        // Decode URI component if it's encoded
        try {
          filename = decodeURIComponent(filename);
        } catch {
          // Keep original if decode fails
        }
      }
    }
    
    // If no filename from header, try to extract from URL
    if (filename === "download") {
      const urlParts = href.split("?")[0].split("/");
      filename = urlParts[urlParts.length - 1] || "download";
    }

    // Create a blob URL and trigger download
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
    }, 100);
    
  } catch (error) {
    console.error("Download error:", error);
    throw error;
  }
}