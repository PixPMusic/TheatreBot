/** Validate every explicit browser navigation, while allowing private HTTP(S) media servers. */
export function validateNavigationUrl(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u0020\u007f]/.test(value)) {
        throw new Error("Enter a valid HTTP or HTTPS URL");
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Enter a valid HTTP or HTTPS URL"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error("Only HTTP and HTTPS URLs without embedded credentials are allowed");
    }
    return url.toString();
}
