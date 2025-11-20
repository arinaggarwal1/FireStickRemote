# Fire TV Remote (Web)

A modern web application that mimics an Amazon Fire TV remote and sends commands via ADB from your server. Features a responsive design with directional pad, app launcher buttons, and comprehensive device management.

## Prerequisites

- Node.js 18+
- ADB installed on the server and in PATH
  - Optionally set `ADB_PATH` if `adb` is not in PATH
- Fire TV with ADB debugging enabled
  - Settings -> My Fire TV -> Developer options -> ADB debugging: ON
  - Note the device IP. Default ADB TCP port is 5555.

## Quick Setup

```bash
cd "/home/username/FireTV Remote"
npm install
npm run start
# or for development (same, just different NODE_ENV)
npm run dev
```

The server listens on http://localhost:9090 by default.

## Device Configuration

### Multiple Device Profiles

The application supports multiple Fire TV devices through a configuration file (`config.yml`):

```yaml
devices:
  - name: "Living Room Fire TV"
    host: "192.168.1.65"
    port: 5555
    default: true
  - name: "Bedroom Fire TV"
    host: "192.168.1.66"
    port: 5555
    default: false
```

### Environment Variables

You can persist default settings via environment variables:

```bash
FIRETV_HOST=192.168.1.65:5555
PORT=9090
NODE_ENV=production
```

### Connection Process

1. **Select Device**: Choose from configured devices in the dropdown
2. **Manual Entry**: Select "Manual" to enter any IP:PORT directly
3. **Connect**: Click "Connect" to establish ADB connection
4. **Pairing**: On first connection, accept the ADB pairing prompt on your Fire TV
5. **Status**: Connection status is indicated by the colored indicator:
   - 🔴 Red: Disconnected
   - 🟡 Yellow: Connecting
   - 🟢 Green: Connected

### Manual IP:PORT Entry

For quick connections to any Fire TV device without configuration:

1. **Select "Manual"** from the device dropdown
2. **Controls expand** to their own line below the header
3. **Enter IP:PORT** (e.g., `192.168.1.100:5555`)
4. **Click Connect** to establish connection

**Layout Behavior:**

- **Manual Mode**: Device controls move to dedicated line with dropdown, input field, and connect button
- **Profile Mode**: Controls return to compact header layout
- **Seamless Switching**: Layout adapts automatically based on selection

## API Endpoints

- `POST /api/connect` → `adb connect <host>`
- `POST /api/disconnect` → `adb disconnect`
- `POST /api/pair { host, code }` → `adb pair <host> <code>`
- `POST /api/key { code }` → `adb shell input keyevent <code>`
- `POST /api/text { text }` → `adb shell input text <encoded>` (space → %s)
- `POST /api/swipe { x1,y1,x2,y2,durationMs }` → touch swipe
- `POST /api/app { app, package }` → `adb shell monkey -p <package> -c <category> 1`

### Common Key Codes

- **Navigation**: Dpad Up 19, Down 20, Left 21, Right 22, Center/OK 23
- **System**: Back 4, Home 3, Power/Wake 224
- **Media**: Play/Pause 85, Next 87, Previous/Rev 88/90 (varies)
- **Volume**: Up 24, Down 25, Mute 164

## App Launching

### Pre-configured Apps

The application includes buttons for popular streaming services:

- **Amazon Prime Video**: `com.amazon.firebat` (uses LEANBACK_LAUNCHER)
- **Netflix**: `com.netflix.ninja`
- **YouTube TV**: `com.amazon.firetv.youtube.tv`
- **Hulu**: `com.hulu.plus`

### Finding App Package Names

To add new apps or troubleshoot existing ones:

1. **List all packages**:

   ```bash
   adb shell pm list packages
   ```

2. **Search for specific apps**:

   ```bash
   adb shell pm list packages | grep -i netflix
   adb shell pm list packages | grep -i prime
   adb shell pm list packages | grep -i youtube
   ```

3. **Find currently running app**:
   ```bash
   adb shell dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp'
   ```

### Testing App Launch Commands

Test app launches manually before adding to the application:

```bash
# Standard apps (most third-party apps)
adb shell monkey -p com.netflix.ninja -c android.intent.category.LAUNCHER 1

# Fire TV native apps (may require LEANBACK_LAUNCHER)
adb shell monkey -p com.amazon.firebat -c android.intent.category.LEANBACK_LAUNCHER 1
```

### Troubleshooting App Launches

- **App doesn't launch**: Check if package name is correct
- **Wrong launcher category**: Try `LEANBACK_LAUNCHER` instead of `LAUNCHER`
- **Permission denied**: Ensure ADB debugging is enabled
- **App not found**: Verify the app is installed on the Fire TV

## Systemd Service Setup

### Install as System Service

1. **Copy service file**:

   ```bash
   sudo cp "firetv-remote.service" /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

2. **Enable and start**:

   ```bash
   sudo systemctl enable firetv-remote
   sudo systemctl start firetv-remote
   ```

3. **Verify status**:
   ```bash
   sudo systemctl status firetv-remote
   ```

### Service Management Commands

```bash
# Start/Stop/Restart
sudo systemctl start firetv-remote
sudo systemctl stop firetv-remote
sudo systemctl restart firetv-remote

# Check status and logs
sudo systemctl status firetv-remote
sudo journalctl -u firetv-remote -f

# Disable auto-start
sudo systemctl disable firetv-remote
```

### Service Configuration

The service file (`firetv-remote.service`) includes:

- Auto-restart on failure
- Runs as your user (not root)
- Waits for network before starting
- Logs to systemd journal
- Production environment settings

## ADB Troubleshooting

### Connection Issues

1. **Verify Fire TV ADB is enabled**:

   - Settings → My Fire TV → Developer options → ADB debugging: ON

2. **Check network connectivity**:

   ```bash
   ping 192.168.1.65
   telnet 192.168.1.65 5555
   ```

3. **List connected devices**:

   ```bash
   adb devices
   ```

4. **Manual connection test**:
   ```bash
   adb connect 192.168.1.65:5555
   adb shell echo "test"
   ```

### Common ADB Issues

- **"device unauthorized"**: Accept pairing prompt on Fire TV
- **"connection refused"**: Check if ADB debugging is enabled
- **"no devices found"**: Verify IP address and port
- **"command not found"**: Ensure ADB is installed and in PATH

### Fire TV Specific Issues

- **Apps from Unknown Sources**: Some Fire TVs require this setting enabled once
- **Developer Options**: May need to be enabled multiple times
- **Network Restrictions**: Ensure Fire TV and server are on same network
- **Firewall**: Check if port 5555 is blocked

## Security Considerations

- **Network Security**: This app executes ADB commands server-side. Host only on trusted networks/VPN
- **Access Control**: Consider binding to a private interface or behind auth/reverse proxy if exposed
- **ADB Security**: ADB connections are not encrypted by default
- **Firewall**: Restrict access to port 9090 (web interface) and 5555 (ADB)

## Deployment Options

### Home Server with VPN

1. **Run on home server** with static local IP
2. **Expose via VPN** so your phone can access the web UI
3. **Ensure connectivity** between server and Fire TV on port 5555

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 9090
CMD ["npm", "start"]
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name firetv.yourdomain.com;

    location / {
        proxy_pass http://localhost:9090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Development

### Project Structure

```
FireTV Remote/
├── public/           # Frontend files
│   ├── index.html   # Main HTML
│   ├── styles.css   # Styling
│   ├── main.js      # Frontend JavaScript
│   └── icons/       # App logos and icons
├── server/          # Backend files
│   └── index.js     # Express server
├── config.yml       # Device configuration
└── package.json     # Dependencies
```

### Adding New Apps

1. **Find package name** using ADB commands above
2. **Test launch command** manually
3. **Add to frontend** (`public/main.js`):
   ```javascript
   const APP_PACKAGES = {
     // ... existing apps
     newapp: "com.newapp.package",
   };
   ```
4. **Add button** to HTML and style as needed
5. **Update backend** if special launcher category needed

### Customization

- **Styling**: Modify `public/styles.css` for visual changes
- **Key mappings**: Update key codes in `public/main.js`
- **Device config**: Edit `config.yml` for multiple devices
- **Server settings**: Modify `server/index.js` for API changes

## Troubleshooting

### General Issues

- **Server won't start**: Check if port 9090 is available
- **ADB not found**: Install Android SDK platform-tools or set `ADB_PATH`
- **Permission denied**: Ensure user has access to ADB and project directory
- **Service won't start**: Check systemd logs with `journalctl -u firetv-remote`

### Fire TV Specific

- **Connection drops**: Fire TV may sleep; wake it up and reconnect
- **Apps not launching**: Verify package names and launcher categories
- **Input not working**: Check if Fire TV is responsive to physical remote
- **Network issues**: Ensure both devices are on same subnet

### Performance

- **Slow response**: Check network latency between server and Fire TV
- **High CPU**: Monitor ADB process usage
- **Memory leaks**: Restart service periodically if needed

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly with your Fire TV
5. Submit a pull request

## License

This project is open source. Please ensure compliance with Amazon's terms of service when using with Fire TV devices.
