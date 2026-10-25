package dev.ayana.mobile;

final class OverlayGeometry {
    private OverlayGeometry() {}
    static int[] fit(int x, int y, int width, int height, int screenWidth, int screenHeight, float density, boolean collapsed) {
        int availableWidth = Math.max(1, screenWidth - Math.round(16 * density));
        int availableHeight = Math.max(1, screenHeight - Math.round(16 * density));
        int minWidth = Math.min(Math.round((collapsed ? 72 : 260) * density), availableWidth);
        int minHeight = Math.min(Math.round((collapsed ? 88 : 300) * density), availableHeight);
        int w = Math.max(minWidth, Math.min(width, availableWidth));
        int h = Math.max(minHeight, Math.min(height, availableHeight));
        return new int[] { Math.max(0, Math.min(x, screenWidth - w)),
            Math.max(0, Math.min(y, screenHeight - h - Math.round(24 * density))), w, h };
    }
}
