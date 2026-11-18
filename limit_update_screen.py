def update_check_only_in_app(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # In checkApplicationUpdates(), only perform the update check if running inside the desktop app:
    # (window.chrome && window.chrome.webview)
    old_code = """      // Application version check: queries self-hosted API and GitHub fallback
      async function checkApplicationUpdates() {
        try {"""

    new_code = """      // Application version check: only active inside desktop app (WebView2)
      async function checkApplicationUpdates() {
        // Never show update screen on website browser - only in native desktop app
        if (!window.chrome || !window.chrome.webview) {
          return;
        }
        try {"""

    if old_code in content:
        content = content.replace(old_code, new_code)
        print(f'Successfully updated checkApplicationUpdates in {filepath}')
    else:
        print(f'Pattern not found in {filepath}')

    # Also in showUpdateDetectedModal, ensure it cannot be opened in browser
    old_show = """      window.showUpdateDetectedModal = function(latestTag, dlUrl) {"""
    new_show = """      window.showUpdateDetectedModal = function(latestTag, dlUrl) {
        // Only show update screen for desktop app
        if (!window.chrome || !window.chrome.webview) return;"""

    if old_show in content:
        content = content.replace(old_show, new_show)
        print(f'Successfully updated showUpdateDetectedModal in {filepath}')
    else:
        print(f'showUpdateDetectedModal not found in {filepath}')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

update_check_only_in_app(r'C:\Users\olivi\Downloads\Rollbux\index.html')
update_check_only_in_app(r'C:\Users\olivi\Downloads\Rollbux\server\dashboard.html')
