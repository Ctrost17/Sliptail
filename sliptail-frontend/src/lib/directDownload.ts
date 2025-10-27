// src/lib/directDownload.ts
// iOS-safe direct download helper that fetches with auth and triggers browser download.

import { loadAuth } from "./auth";

export async function directDownload(href: string) {
  try {
    // Get the auth token
    const auth = loadAuth();
    const token = auth?.token || null;
    
    // Make authenticated request but handle redirects manually
    // This prevents Authorization header from being sent to external URLs (CloudFront/S3)
    const response = await fetch(href, {
      method: "GET",
      credentials: "include", // include cookies
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "manual", // Handle redirects manually
    });
    
    // If we get a redirect, fetch the redirected URL without auth headers
    if (response.status >= 300 && response.status < 400) {
      const redirectUrl = response.headers.get("Location");
      if (!redirectUrl) {
        throw new Error("Redirect received but no Location header");
      }
      
      // Fetch the redirect URL without auth (for CloudFront/S3 signed URLs)
      const redirectResponse = await fetch(redirectUrl, {
        method: "GET",
        redirect: "follow",
        // No credentials or auth headers for external CDN
      });
      
      if (!redirectResponse.ok) {
        const errorData = await redirectResponse.json().catch(() => ({ error: `HTTP ${redirectResponse.status}` }));
        throw new Error(errorData.error || `Download failed: ${redirectResponse.status}`);
      }
      
      // Use the redirect response for the download
      const blob = await redirectResponse.blob();
      
      // Extract filename from Content-Disposition header if available
      const contentDisposition = redirectResponse.headers.get("Content-Disposition");
      let filename = "download";
      
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1].replace(/['"]/g, '');
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
      
      return;
    }

    // If not a redirect, handle as a direct response
    if (!response.ok) {
      // Try to get error message from response
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || `Download failed: ${response.status}`);
    }

    // Get the blob from the response (direct download, no redirect)
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