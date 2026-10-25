package dev.ayana.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Hosts the SAME Capacitor WebView: no second socket, history store or audio clock. */
public class CompanionOverlayService extends Service {
    static CompanionOverlayService current;
    private static final String CHANNEL = "ayana-companion";
    private static final int NOTIFICATION = 4102;
    private WindowManager manager;
    private WindowManager.LayoutParams bounds;
    private FrameLayout surface;
    private WebView webView;
    private ViewGroup originalParent;
    private ViewGroup.LayoutParams originalLayout;
    private int originalIndex;
    private int expandedWidth, expandedHeight;
    private boolean attached, collapsed, finishing;
    private SharedPreferences preferences;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable permissionCheck = new Runnable() {
        @Override public void run() {
            if (finishing) return;
            if (!Settings.canDrawOverlays(CompanionOverlayService.this)) {
                AyanaCompanionPlugin plugin = AyanaCompanionPlugin.owner.get();
                if (plugin != null) plugin.cancelAction();
                finish(false); return;
            }
            handler.postDelayed(this, 2000);
        }
    };
    public boolean isAttached() { return attached; }
    public boolean isCollapsed() { return collapsed; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() {
        super.onCreate(); current = this;
        manager = (WindowManager) getSystemService(WINDOW_SERVICE);
        preferences = getSharedPreferences("ayana-floating", MODE_PRIVATE);
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "彩名悬浮陪伴", NotificationManager.IMPORTANCE_LOW));
        Intent restore = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent open = PendingIntent.getActivity(this, 0, restore, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, CompanionOverlayService.class).setAction("close");
        PendingIntent close = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_companion_notification).setContentTitle("彩名正在悬浮陪伴")
            .setContentText("点此返回聊天，可随时关闭悬浮窗").setOngoing(true).setContentIntent(open)
            .addAction(0, "返回 Ayana", open).addAction(0, "关闭悬浮窗", close).build();
        try {
            ServiceCompat.startForeground(this, NOTIFICATION, notification,
                Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
        } catch (Exception error) {
            AyanaCompanionPlugin plugin = AyanaCompanionPlugin.owner.get();
            if (plugin != null) plugin.completeStart("系统未允许启动悬浮陪伴服务");
            stopSelf();
        }
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "close".equals(intent.getAction())) {
            AyanaCompanionPlugin plugin = AyanaCompanionPlugin.owner.get();
            if (plugin != null) plugin.cancelAction();
            finish(false); return START_NOT_STICKY;
        }
        if (attached || finishing) return START_NOT_STICKY;
        AyanaCompanionPlugin plugin = AyanaCompanionPlugin.owner.get();
        if (plugin == null || plugin.getActivity().isFinishing()) { stopSelf(); return START_NOT_STICKY; }
        try {
            if (!Settings.canDrawOverlays(this)) throw new IllegalStateException();
            webView = plugin.getBridge().getWebView();
            originalParent = (ViewGroup) webView.getParent();
            originalIndex = originalParent.indexOfChild(webView);
            originalLayout = webView.getLayoutParams();
            float density = getResources().getDisplayMetrics().density;
            expandedWidth = preferences.getInt("width", (int)(340 * density));
            expandedHeight = preferences.getInt("height", (int)(440 * density));
            bounds = new WindowManager.LayoutParams(expandedWidth, expandedHeight,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
            bounds.gravity = Gravity.TOP | Gravity.LEFT;
            bounds.x = preferences.getInt("x", 16); bounds.y = preferences.getInt("y", (int)(120 * density));
            bounds.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
            surface = new FrameLayout(this);
            surface.setBackgroundColor(Color.TRANSPARENT);
            originalParent.removeView(webView);
            webView.setBackgroundColor(Color.TRANSPARENT);
            surface.addView(webView, new FrameLayout.LayoutParams(-1, -1));
            clamp();
            manager.addView(surface, bounds); attached = true;
            webView.onResume(); webView.resumeTimers();
            plugin.completeStart(null);
            // Wait for the JS state acknowledgement before leaving the Activity.
            handler.postDelayed(() -> { if (attached && !finishing) plugin.getActivity().moveTaskToBack(true); }, 150);
            handler.postDelayed(permissionCheck, 2000);
        } catch (Exception error) {
            plugin.completeStart("悬浮窗无法显示，请检查系统的悬浮窗权限");
            finish(false);
        }
        return START_NOT_STICKY;
    }
    private void clamp() {
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        float density = metrics.density;
        int screenWidth = metrics.widthPixels, screenHeight = metrics.heightPixels;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Rect display = manager.getMaximumWindowMetrics().getBounds();
            screenWidth = display.width(); screenHeight = display.height();
        }
        int[] fitted = OverlayGeometry.fit(bounds.x, bounds.y, bounds.width, bounds.height, screenWidth, screenHeight, density, collapsed);
        bounds.x = fitted[0]; bounds.y = fitted[1]; bounds.width = fitted[2]; bounds.height = fitted[3];
    }
    private void update() {
        if (!attached || finishing) return;
        try { clamp(); manager.updateViewLayout(surface, bounds); }
        catch (Exception error) { finish(false); }
    }
    private void save() {
        if (bounds == null) return;
        preferences.edit().putInt("x", bounds.x).putInt("y", bounds.y)
            .putInt("width", expandedWidth).putInt("height", expandedHeight).apply();
    }
    public void move(double dx, double dy, boolean settle) {
        if (!Double.isFinite(dx) || !Double.isFinite(dy) || bounds == null) return;
        // CSS pixels and Android layout pixels differ on high density devices.
        float density = getResources().getDisplayMetrics().density;
        bounds.x += (int)(dx * density); bounds.y += (int)(dy * density); update();
        if (settle) {
            int width = getResources().getDisplayMetrics().widthPixels;
            if (Build.VERSION.SDK_INT >= 30) width = manager.getMaximumWindowMetrics().getBounds().width();
            bounds.x = bounds.x + bounds.width / 2 < width / 2 ? 0 : width - bounds.width;
            update(); save();
        }
    }
    public void resize(double width, double height) {
        if (collapsed || bounds == null || !Double.isFinite(width) || !Double.isFinite(height)) return;
        float density = getResources().getDisplayMetrics().density;
        bounds.width = (int)(width * density); bounds.height = (int)(height * density); update();
        expandedWidth = bounds.width; expandedHeight = bounds.height; save();
    }
    public void collapse(boolean value) {
        if (bounds == null || collapsed == value) return;
        focus(false); collapsed = value;
        float density = getResources().getDisplayMetrics().density;
        bounds.width = value ? (int)(72 * density) : expandedWidth;
        bounds.height = value ? (int)(88 * density) : expandedHeight;
        update(); save();
    }
    public void focus(boolean enabled) {
        if (bounds == null) return;
        if (enabled) bounds.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        else {
            ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(surface.getWindowToken(), 0);
            bounds.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        }
        update();
        if (enabled && webView != null) {
            webView.requestFocus();
            handler.postDelayed(() -> ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT), 100);
        }
    }
    @Override public void onConfigurationChanged(Configuration configuration) { super.onConfigurationChanged(configuration); update(); }
    @Override public void onTaskRemoved(Intent rootIntent) {
        AyanaCompanionPlugin plugin = AyanaCompanionPlugin.owner.get();
        if (plugin != null) plugin.cancelAction();
        finish(false);
    }
    public void finish(boolean restore) {
        if (finishing) return;
        finishing = true; handler.removeCallbacksAndMessages(null); save();
        if (webView != null) {
            ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(webView.getWindowToken(), 0);
            if (surface != null) surface.removeView(webView);
            if (originalParent != null && webView.getParent() == null) originalParent.addView(webView, Math.min(originalIndex, originalParent.getChildCount()), originalLayout);
        }
        if (attached) { try { manager.removeView(surface); } catch (Exception ignored) {} }
        attached = false; collapsed = false;
        AyanaCompanionPlugin plugin = AyanaCompanionPlugin.owner.get();
        if (plugin != null) plugin.changed();
        if (restore) startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onDestroy() {
        if (!finishing) finish(false);
        current = null; super.onDestroy();
    }
}
