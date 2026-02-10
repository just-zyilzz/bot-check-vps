$msg = Read-Host -Prompt "Masukkan pesan commit (Enter untuk default: 'Update bot features')"
if ([string]::IsNullOrWhiteSpace($msg)) {
    $msg = "Update bot features"
}

Write-Host "📦 Menambahkan file ke staging..." -ForegroundColor Cyan
git add .

Write-Host "💾 Commit perubahan..." -ForegroundColor Cyan
git commit -m "$msg"

Write-Host "🚀 Upload ke GitHub..." -ForegroundColor Cyan
git push origin main

if ($?) {
    Write-Host "✅ Berhasil deploy ke GitHub!" -ForegroundColor Green
} else {
    Write-Host "❌ Gagal deploy. Cek error di atas." -ForegroundColor Red
}

Read-Host "Tekan Enter untuk keluar..."
