package dev.ayana.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AyanaVaultPlugin.class);
        registerPlugin(AyanaCompanionPlugin.class);
        super.onCreate(savedInstanceState);
    }
    @Override public void onResume() {
        super.onResume();
        CompanionOverlayService service = CompanionOverlayService.current;
        if (service != null && service.isAttached()) service.finish(false);
    }
    @Override public void onDetachedFromWindow() {
        CompanionOverlayService service = CompanionOverlayService.current;
        if (service != null && service.isAttached()) return;
        super.onDetachedFromWindow();
    }
}
