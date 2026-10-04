param([Parameter(Mandatory=$true)][string]$StatePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[AppContext]::SetSwitch('Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures', $false)
[AppContext]::SetSwitch('Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures.2', $false)
[AppContext]::SetSwitch('Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures.3', $false)
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'UFO2 Ayana Probe'
$form.Size = New-Object System.Drawing.Size(700, 450)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(160, 180)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true
$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'UFO2 / Ayana desktop execution test'
$heading.Location = New-Object System.Drawing.Point(25, 25)
$heading.Size = New-Object System.Drawing.Size(630, 35)
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Message / 消息'
$label.Location = New-Object System.Drawing.Point(25, 85)
$label.Size = New-Object System.Drawing.Size(630, 30)
$entry = New-Object System.Windows.Forms.TextBox
$entry.Name = 'messageInput'
$entry.AccessibleName = 'Message input'
$entry.Text = 'Replace this text'
$entry.Location = New-Object System.Drawing.Point(25, 125)
$entry.Size = New-Object System.Drawing.Size(630, 35)
$apply = New-Object System.Windows.Forms.Button
$apply.Name = 'applyMessage'
$apply.Text = 'Apply message'
$apply.AccessibleName = 'Apply message'
$apply.Location = New-Object System.Drawing.Point(25, 190)
$apply.Size = New-Object System.Drawing.Size(190, 45)
$output = New-Object System.Windows.Forms.Label
$output.Name = 'resultLabel'
$output.AccessibleName = 'Result'
$output.Text = 'Waiting'
$output.Location = New-Object System.Drawing.Point(25, 270)
$output.Size = New-Object System.Drawing.Size(630, 65)
$option = New-Object System.Windows.Forms.CheckBox
$option.Name = 'enableOption'
$option.AccessibleName = 'Enable option'
$option.Text = 'Enable option'
$option.Location = New-Object System.Drawing.Point(250, 195)
$option.Size = New-Object System.Drawing.Size(250, 40)
$script:applyCount = 0
$apply.Add_Click({ $script:applyCount++; $output.Text = 'Received: ' + $entry.Text })
$form.Controls.AddRange(@($heading, $label, $entry, $apply, $output, $option))
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
    $state = @{ hwnd=$form.Handle.ToInt64(); process_id=$PID; title=$form.Text;
        message=$entry.Text; output=$output.Text; apply_count=$script:applyCount; option_enabled=$option.Checked;
        bounds=@{x=$form.Left;y=$form.Top;width=$form.Width;height=$form.Height} }
    $temporary = $StatePath + '.tmp'
    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $StatePath -Force
})
$form.Add_Shown({ $timer.Start(); $entry.Focus() })
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[void]$form.ShowDialog()
$form.Dispose()
