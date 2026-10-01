package com.bidouille.carhooks

import android.content.Intent
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.bidouille.carhooks.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var store: WebhookStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        store = WebhookStore(this)

        binding.btnDepart.setOnClickListener { trigger(ActionId.DEPART) }
        binding.btnArrivee.setOnClickListener { trigger(ActionId.ARRIVEE) }
        binding.btnSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        val missing = ActionId.entries.filterNot { store.load(it).isConfigured }
        binding.txtStatus.text = when {
            missing.isEmpty() -> getString(R.string.idle)
            else -> "À configurer : " + missing.joinToString(", ") { it.label }
        }
    }

    private fun trigger(id: ActionId) {
        val button = if (id == ActionId.DEPART) binding.btnDepart else binding.btnArrivee
        button.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        button.isEnabled = false
        binding.txtStatus.text = "${id.label} — envoi…"

        WebhookClient.fire(store.load(id)) { result ->
            button.isEnabled = true
            binding.txtStatus.text = "${id.label} : ${result.message}"
            store.setLastResult(id, result.message)
            if (!result.ok) {
                Toast.makeText(this, result.message, Toast.LENGTH_LONG).show()
            }
        }
    }
}
