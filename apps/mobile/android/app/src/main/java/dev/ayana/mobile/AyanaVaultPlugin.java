package dev.ayana.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "AyanaVault")
public class AyanaVaultPlugin extends Plugin {
    private static final String ALIAS = "dev.ayana.mobile.session.v1";
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    @PluginMethod public void set(PluginCall call) {
        try {
            String value = call.getString("value");
            if (value == null || value.length() > 16384) throw new IllegalArgumentException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            boolean saved = getContext().getSharedPreferences("ayana-vault", Context.MODE_PRIVATE).edit().putString("session", encrypted).commit();
            if (!saved) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) { call.reject("无法安全保存激活凭据"); }
    }
    @PluginMethod public void get(PluginCall call) {
        try {
            String saved = getContext().getSharedPreferences("ayana-vault", Context.MODE_PRIVATE).getString("session", "");
            String value = "";
            if (!saved.isEmpty()) {
                String[] parts = saved.split("\\.", 2);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                value = new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            }
            JSObject result = new JSObject(); result.put("value", value); call.resolve(result);
        } catch (Exception error) { call.reject("无法读取安全凭据，请重新激活"); }
    }
    @PluginMethod public void clear(PluginCall call) {
        if (getContext().getSharedPreferences("ayana-vault", Context.MODE_PRIVATE).edit().clear().commit()) call.resolve();
        else call.reject("无法清除凭据");
    }
}
