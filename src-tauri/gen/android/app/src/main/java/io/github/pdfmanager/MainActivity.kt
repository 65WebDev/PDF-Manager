package io.github.pdfmanager

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Light status / navigation bar icons: the bars sit over the dark toolbar
    // colour (windowBackground) whatever the system theme.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )
    super.onCreate(savedInstanceState)
    // The app is drawn edge to edge (always so from Android 15): keep the
    // editor clear of the status bar, the navigation bar, a camera cutout
    // and the on-screen keyboard. In reading mode the bars are hidden, their
    // insets drop to zero and the pages get the whole screen.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val pad = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(pad.left, pad.top, pad.right, pad.bottom)
      WindowInsetsCompat.CONSUMED
    }
    preferFastestRefreshRate()
  }

  // Text scrolled at 60 Hz on a 90/120 Hz screen visibly judders next to a
  // native reader. Ask for the screen's fastest mode at its current
  // resolution; the system can still lower it (battery saver, a user limit).
  private fun preferFastestRefreshRate() {
    val screen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      this.display
    } else {
      @Suppress("DEPRECATION")
      windowManager.defaultDisplay
    } ?: return
    val current = screen.mode
    val fastest = screen.supportedModes
      .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
      .maxByOrNull { it.refreshRate } ?: return
    if (fastest.refreshRate <= current.refreshRate) return
    window.attributes = window.attributes.also { it.preferredDisplayModeId = fastest.modeId }
  }
}
