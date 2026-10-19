package io.github.pdfmanager

import android.graphics.Color
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
  }
}
