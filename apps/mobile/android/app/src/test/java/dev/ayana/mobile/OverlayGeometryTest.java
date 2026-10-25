package dev.ayana.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class OverlayGeometryTest {
    @Test public void resizeCannotLoseTheWindowOffScreen() {
        int[] b = OverlayGeometry.fit(9000, 9000, 9000, 9000, 1080, 2400, 3, false);
        assertTrue(b[0] >= 0 && b[0] + b[2] <= 1080);
        assertTrue(b[1] >= 0 && b[1] + b[3] <= 2400);
    }
    @Test public void phoneRotationKeepsOldPositionReachable() {
        int[] b = OverlayGeometry.fit(800, 1800, 1020, 1320, 2400, 1080, 3, false);
        assertTrue(b[1] + b[3] <= 1080);
        assertTrue(b[3] >= 900);
    }
    @Test public void draggingAboveTheDisplayStopsAtZero() {
        int[] b = OverlayGeometry.fit(-100, -300, 340, 440, 390, 844, 1, false);
        assertEquals(0, b[0]); assertEquals(0, b[1]);
    }
    @Test public void expandedWindowHasUsableMinimumSize() {
        int[] b = OverlayGeometry.fit(0, 0, 1, 1, 1080, 2400, 3, false);
        assertEquals(780, b[2]); assertEquals(900, b[3]);
    }
    @Test public void collapsedPortraitRemainsSmallOnDenseScreens() {
        int[] b = OverlayGeometry.fit(0, 0, 216, 264, 1080, 2400, 3, true);
        assertEquals(216, b[2]); assertEquals(264, b[3]);
    }
    @Test public void tinyMultiwindowDisplayNeverProducesNegativeSize() {
        int[] b = OverlayGeometry.fit(500, 500, 340, 440, 220, 240, 1, false);
        assertTrue(b[2] > 0 && b[2] <= 220);
        assertTrue(b[3] > 0 && b[3] <= 240);
        assertTrue(b[0] + b[2] <= 220 && b[1] + b[3] <= 240);
    }
}
