package com.bidouille.carhooks

import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.bidouille.carhooks.databinding.ActivitySettingsBinding
import com.bidouille.carhooks.databinding.BlockActionBinding

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private lateinit var store: WebhookStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        store = WebhookStore(this)

        bind(binding.blockDepart, ActionId.DEPART)
        bind(binding.blockArrivee, ActionId.ARRIVEE)

        binding.btnSave.setOnClickListener {
            saveAll()
            Toast.makeText(this, "Enregistré", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    override fun onPause() {
        super.onPause()
        // Safety net: typing is not lost if the screen is left without hitting Save.
        saveAll()
    }

    private fun bind(block: BlockActionBinding, id: ActionId) {
        val config = store.load(id)
        block.lblTitle.text = id.label
        block.editUrl.setText(config.url)
        block.editBody.setText(config.body)
        block.radioGet.isChecked = !config.post
        block.radioPost.isChecked = config.post
        block.txtResult.text = store.lastResult(id).orEmpty()

        updateBodyVisibility(block)
        block.groupMethod.setOnCheckedChangeListener { _, _ -> updateBodyVisibility(block) }

        block.btnTest.setOnClickListener {
            val current = read(block, id)
            store.save(current)
            block.btnTest.isEnabled = false
            block.txtResult.text = "Envoi…"
            WebhookClient.fire(current) { result ->
                block.btnTest.isEnabled = true
                block.txtResult.text = result.message
                store.setLastResult(id, result.message)
            }
        }
    }

    private fun updateBodyVisibility(block: BlockActionBinding) {
        block.layoutBody.visibility = if (block.radioPost.isChecked) View.VISIBLE else View.GONE
    }

    private fun read(block: BlockActionBinding, id: ActionId) = ActionConfig(
        id = id,
        url = block.editUrl.text?.toString().orEmpty(),
        post = block.radioPost.isChecked,
        body = block.editBody.text?.toString().orEmpty()
    )

    private fun saveAll() {
        store.save(read(binding.blockDepart, ActionId.DEPART))
        store.save(read(binding.blockArrivee, ActionId.ARRIVEE))
    }
}
