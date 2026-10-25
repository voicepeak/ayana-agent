package dev.ayana.mobile;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

@CapacitorPlugin(name = "AyanaCompanion")
public class AyanaCompanionPlugin extends Plugin {
    static WeakReference<AyanaCompanionPlugin> owner = new WeakReference<>(null);
    private PluginCall starting;
    @Override public void load() { owner = new WeakReference<>(this); }
    static JSObject state(android.content.Context context) {
        JSObject value = new JSObject();
        value.put("overlay", true); value.put("pip", false);
        value.put("permission", Settings.canDrawOverlays(context));
        value.put("active", CompanionOverlayService.current != null && CompanionOverlayService.current.isAttached());
        value.put("collapsed", CompanionOverlayService.current != null && CompanionOverlayService.current.isCollapsed());
        return value;
    }
    void changed() { notifyListeners("state", state(getContext())); }
    void cancelAction() { JSObject value = new JSObject(); value.put("action", "cancel"); notifyListeners("action", value); }
    void completeStart(String error) {
        PluginCall call = starting; starting = null;
        if (call != null) { if (error == null) call.resolve(); else call.reject(error); }
        changed();
    }
    @PluginMethod public void status(PluginCall call) { call.resolve(state(getContext())); }
    @PluginMethod public void requestPermission(PluginCall call) {
        if (Settings.canDrawOverlays(getContext())) { JSObject value = new JSObject(); value.put("granted", true); call.resolve(value); return; }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, intent, "permissionResult");
        } catch (Exception error) { call.reject("无法打开悬浮窗权限，请在系统设置中允许 Ayana 显示在其他应用上层"); }
    }
    @ActivityCallback private void permissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject value = new JSObject(); value.put("granted", Settings.canDrawOverlays(getContext())); call.resolve(value);
        changed();
    }
    @PluginMethod public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!Settings.canDrawOverlays(getContext())) { call.reject("请先允许悬浮窗权限"); return; }
            if (CompanionOverlayService.current != null && CompanionOverlayService.current.isAttached()) { call.resolve(); return; }
            if (starting != null) { call.reject("悬浮窗正在打开"); return; }
            starting = call;
            owner = new WeakReference<>(this);
            try {
                ContextCompat.startForegroundService(getContext(), new Intent(getContext(), CompanionOverlayService.class));
            } catch (Exception error) { completeStart("暂时无法启动悬浮窗，请回到 Ayana 后重试"); }
        });
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CompanionOverlayService service = CompanionOverlayService.current;
            if (service != null) service.finish(Boolean.TRUE.equals(call.getBoolean("restore", false)));
            call.resolve();
        });
    }
    @PluginMethod public void move(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CompanionOverlayService service = CompanionOverlayService.current;
            if (service != null) service.move(call.getDouble("dx", 0d), call.getDouble("dy", 0d), Boolean.TRUE.equals(call.getBoolean("settle", false)));
            call.resolve();
        });
    }
    @PluginMethod public void resize(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CompanionOverlayService service = CompanionOverlayService.current;
            if (service != null) service.resize(call.getDouble("width", 340d), call.getDouble("height", 440d));
            call.resolve();
        });
    }
    @PluginMethod public void collapse(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CompanionOverlayService service = CompanionOverlayService.current;
            if (service != null) service.collapse(Boolean.TRUE.equals(call.getBoolean("collapsed", false)));
            changed(); call.resolve();
        });
    }
    @PluginMethod public void focus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CompanionOverlayService service = CompanionOverlayService.current;
            if (service != null) service.focus(Boolean.TRUE.equals(call.getBoolean("enabled", false)));
            call.resolve();
        });
    }
    @PluginMethod public void present(PluginCall call) { call.resolve(); }
    @Override protected void handleOnDestroy() {
        CompanionOverlayService service = CompanionOverlayService.current;
        if (service != null) service.finish(false);
        if (starting != null) completeStart("界面已关闭");
        if (owner.get() == this) owner.clear();
    }
}
