package local.novel.nightread;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.webkit.HttpAuthHandler;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.net.URI;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String DEFAULT_SERVER = "";
    private static final int MIC_REQUEST = 1;
    private WebView web;
    private TextView status;
    private URI server;
    private PermissionRequest pendingMic;
    private ValueCallback<Uri[]> fileSelection;
    private android.speech.SpeechRecognizer recognizer;
    private android.speech.tts.TextToSpeech speaker;
    private boolean calling;
    private int callId;

    private void endCall() {
        calling = false;
        callId++;
        if (recognizer != null) { recognizer.destroy(); recognizer = null; }
        if (speaker != null) speaker.stop();
    }

    private void listen() {
        if (!calling) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 2);
            return;
        }
        final int session = callId;
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) {
            callError("手机没有可用的语音识别服务");
            return;
        }
        if (recognizer != null) recognizer.destroy();
        recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new android.speech.RecognitionListener() {
            public void onReadyForSpeech(Bundle b) {}
            public void onBeginningOfSpeech() {}
            public void onRmsChanged(float v) {}
            public void onBufferReceived(byte[] b) {}
            public void onEndOfSpeech() {}
            public void onPartialResults(Bundle b) {}
            public void onEvent(int e, Bundle b) {}
            public void onError(int e) {
                if (!calling || session != callId) return;
                if (e == 6 || e == 7) web.postDelayed(() -> { if (calling && session == callId) listen(); }, 450);
                else callError("语音识别服务连接失败");
            }
            public void onResults(Bundle b) {
                if (!calling || session != callId) return;
                java.util.List<String> words = b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
                if (words == null || words.isEmpty()) { listen(); return; }
                web.evaluateJavascript("window.novelCallInput(" + org.json.JSONObject.quote(words.get(0)) + ")", null);
            }
        });
        android.content.Intent intent = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        recognizer.startListening(intent);
    }

    private void callError(String message) {
        endCall();
        web.evaluateJavascript("window.novelCallError(" + org.json.JSONObject.quote(message) + ")", null);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        speaker = new android.speech.tts.TextToSpeech(this, result -> {
            if (result == android.speech.tts.TextToSpeech.SUCCESS && speaker != null) speaker.setLanguage(Locale.SIMPLIFIED_CHINESE);
        });
        speaker.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
            public void onStart(String id) {}
            public void onDone(String id) { runOnUiThread(() -> { if (calling && id.equals(String.valueOf(callId))) listen(); }); }
            public void onError(String id) { runOnUiThread(() -> { if (calling && id.equals(String.valueOf(callId))) callError("中文朗读失败"); }); }
        });
        getWindow().setStatusBarColor(Color.WHITE);
        int bars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            getWindow().setNavigationBarColor(Color.WHITE);
            bars |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(bars);
        server = parseServer(getPreferences(MODE_PRIVATE).getString("server", DEFAULT_SERVER));
        

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(Color.WHITE);
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        status = new TextView(this);
        status.setTextColor(Color.rgb(48, 58, 51));
        status.setPadding(dp(12), 0, dp(4), 0);
        toolbar.addView(status, new LinearLayout.LayoutParams(0, -2, 1));
        Button connection = new Button(this);
        connection.setText("连接设置");
        connection.setOnClickListener(view -> settings());
        toolbar.addView(connection, new LinearLayout.LayoutParams(-2, dp(48)));
        column.addView(toolbar);
        toolbar.setVisibility(View.GONE);

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        configureWebView();
        column.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(column);
        if (server == null) { toolbar.setVisibility(View.VISIBLE); settings(); } else load();
    }

    private void configureWebView() {
        WebSettings config = web.getSettings();
        config.setJavaScriptEnabled(true);
        config.setUserAgentString(config.getUserAgentString() + " NightReadPhone/1.2");
        config.setDomStorageEnabled(true);
        config.setAllowFileAccess(false);
        config.setAllowContentAccess(false);
        config.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        config.setSupportMultipleWindows(false);

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri command = request.getUrl();
                if ("nightread-call".equals(command.getScheme())) {
                    Uri current = Uri.parse(view.getUrl() == null ? "" : view.getUrl());
                    if (!request.isForMainFrame() || !sameOrigin(current) || !novelPath(current)) return true;
                    if ("start".equals(command.getHost()) && !calling) { calling = true; callId++; listen(); }
                    if ("end".equals(command.getHost())) endCall();
                    if ("reply".equals(command.getHost()) && calling) {
                        String text = command.getQueryParameter("text");
                        if (text == null || text.isEmpty()) listen();
                        else if (speaker.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, String.valueOf(callId)) < 0)
                            callError("请检查手机中文语音引擎");
                    }
                    return true;
                }
                return !sameOrigin(request.getUrl()) || !novelPath(request.getUrl());
            }

            @Override public void onPageFinished(WebView view, String url) {
                if ("正在连接…".contentEquals(status.getText())) status.setText(server.getHost());
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    status.setText("连接失败，请检查电脑和网络");
                    ((View)status.getParent()).setVisibility(View.VISIBLE);
                }
            }

            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                if (!server.getHost().equalsIgnoreCase(host)) {
                    handler.cancel();
                    return;
                }
                login(handler);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!sameOrigin(Uri.parse(view.getUrl()))) return false;
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                boolean imageOnly = java.util.Arrays.asList(params.getAcceptTypes()).contains("image/*");
                pick.setType(imageOnly ? "image/*" : "*/*");
                if (!imageOnly) pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json","image/png","application/octet-stream"});
                try { startActivityForResult(pick, 3); }
                catch (android.content.ActivityNotFoundException error) { fileSelection = null; callback.onReceiveValue(null); }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> askForMicrophone(request));
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMic == request) pendingMic = null;
            }
        });
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != 3 || fileSelection == null) return;
        Uri chosen = result == RESULT_OK && data != null ? data.getData() : null;
        fileSelection.onReceiveValue(chosen != null && "content".equals(chosen.getScheme()) ? new Uri[]{chosen} : null);
        fileSelection = null;
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("Boolean(window.novelBack && window.novelBack())", handled -> {
            if (!"true".equals(handled)) super.onBackPressed();
        });
    }

    private boolean sameOrigin(Uri link) {
        return server.getScheme().equalsIgnoreCase(link.getScheme()) &&
            server.getHost().equalsIgnoreCase(link.getHost()) &&
            port(server.getPort(), server.getScheme()) == port(link.getPort(), link.getScheme());
    }

    private static boolean novelPath(Uri link) {
        final String path = link.getPath();
        return path != null && (path.equals("/novel") || path.startsWith("/novel/"));
    }

    private static int port(int value, String scheme) {
        return value == -1 ? ("https".equalsIgnoreCase(scheme) ? 443 : 80) : value;
    }

    private void load() {
        if (server == null) return;
        status.setText("正在连接…");
        web.loadUrl(server.toASCIIString() + "/novel/");
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void settings() {
        final EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("http://192.168.x.x:8001");
        if (server != null) field.setText(server.toASCIIString());
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("夜读服务器")
            .setMessage("在家填写电脑的局域网地址。外出时使用已配置的 Tailscale HTTPS 地址。")
            .setView(withPadding(field))
            .setNegativeButton("取消", null)
            .setNeutralButton("重新连接", (window, button) -> load())
            .setPositiveButton("连接", null)
            .create();
        dialog.setOnShowListener(event -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            URI candidate = parseServer(field.getText().toString());
            if (candidate == null) {
                field.setError("请输入局域网 IP 和端口，或 Tailscale 的 HTTPS 地址");
                return;
            }
            server = candidate;
            getPreferences(MODE_PRIVATE).edit().putString("server", candidate.toASCIIString()).apply();
            dialog.dismiss();
            load();
        }));
        dialog.show();
    }

    private static URI parseServer(String input) {
        try {
            URI uri = new URI(input.trim());
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                uri.getPort() == 0 || uri.getPort() > 65535 ||
                !uri.getPath().matches("/?|/novel/?")) return null;
            if (!("http".equals(scheme) && privateAddress(host)) &&
                !("https".equals(scheme) && host.endsWith(".ts.net"))) return null;
            return new URI(scheme, null, host, uri.getPort(), null, null, null);
        } catch (Exception exception) {
            return null;
        }
    }

    private static boolean privateAddress(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] values = new int[4];
        for (int i = 0; i < parts.length; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            values[i] = Integer.parseInt(parts[i]);
            if (values[i] > 255) return false;
        }
        return values[0] == 10 || (values[0] == 192 && values[1] == 168) ||
            (values[0] == 172 && values[1] >= 16 && values[1] <= 31);
    }

    private LinearLayout withPadding(View... views) {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(22), dp(8), dp(22), dp(8));
        for (View view : views) content.addView(view);
        return content;
    }

    private void login(HttpAuthHandler handler) {
        EditText username = new EditText(this);
        username.setHint("用户名");
        username.setSingleLine(true);
        EditText password = new EditText(this);
        password.setHint("密码");
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        new AlertDialog.Builder(this)
            .setTitle("登录夜读")
            .setView(withPadding(username, password))
            .setPositiveButton("登录", (dialog, button) -> handler.proceed(
                username.getText().toString(), password.getText().toString()))
            .setNegativeButton("取消", (dialog, button) -> handler.cancel())
            .setOnCancelListener(dialog -> handler.cancel())
            .show();
    }

    private void askForMicrophone(PermissionRequest request) {
        boolean microphone = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) microphone = true;
        }
        if (!microphone || !sameOrigin(request.getOrigin()) || !"https".equals(server.getScheme()) || pendingMic != null) {
            request.deny();
        } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            pendingMic = request;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MIC_REQUEST);
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 2 && calling) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) listen();
            else callError("通话需要麦克风权限");
            return;
        }
        if (code != MIC_REQUEST || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && sameOrigin(pendingMic.getOrigin()))
            pendingMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        else pendingMic.deny();
        pendingMic = null;
    }
    @Override protected void onDestroy() {
        endCall();
        if (speaker != null) speaker.shutdown();
        super.onDestroy();
    }
}
