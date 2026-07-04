Name:           papa-audio
Version:        1.0.0
Release:        1%{?dist}
Summary:        Papa Audio — hi-fi music player
License:        MIT
URL:            https://github.com/shaharyar/papa-audio
BuildArch:      x86_64
Requires:       gtk3, libnotify, nss, libXScrnSaver, libXtst, xdg-utils, at-spi2-core, libuuid

%description
Papa Audio is a hi-fi music player built with Electron.
Supports FLAC, MP3, WAV, AIFF, M4A, OGG, and Opus formats.

%install
mkdir -p %{buildroot}/opt/papa-audio
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/usr/share/applications
mkdir -p %{buildroot}/usr/share/icons/hicolor/512x512/apps

cp -r /home/shaharyar/flac-player/dist/linux-unpacked/. %{buildroot}/opt/papa-audio/
cp /home/shaharyar/flac-player/assets/icon.png %{buildroot}/usr/share/icons/hicolor/512x512/apps/papa-audio.png

ln -sf /opt/papa-audio/papa-audio %{buildroot}/usr/bin/papa-audio

cat > %{buildroot}/usr/share/applications/papa-audio.desktop << 'EOF'
[Desktop Entry]
Name=Papa Audio
Comment=Hi-fi music player
Exec=/opt/papa-audio/papa-audio
Icon=papa-audio
Terminal=false
Type=Application
Categories=Audio;Music;Player;AudioVideo;
MimeType=audio/flac;audio/mpeg;audio/wav;audio/aiff;audio/mp4;audio/ogg;audio/opus;
StartupWMClass=papa-audio
EOF

%files
/opt/papa-audio/
/usr/bin/papa-audio
/usr/share/applications/papa-audio.desktop
/usr/share/icons/hicolor/512x512/apps/papa-audio.png

%post
/bin/chmod 4755 /opt/papa-audio/chrome-sandbox
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

%postun
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

%changelog
* Thu Jun 18 2026 Shaharyar <awaiskhan81008@gmail.com> - 1.0.0-1
- Initial release
