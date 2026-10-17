"""Run the wizard's real Stage 3 display without prompting or reading secrets."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/prepare-first-deploy.sh"


class PreparationPromptTests(unittest.TestCase):
    def test_stage_three_displays_secret_path_before_input(self):
        source = SCRIPT.read_text()
        library = source[:source.index("# STAGES: author this section.")]
        start = source.index("stage 'WorkOS API key：")
        end = source.index('\nENV_FILE="$TOB_SECRET_FILE"', start)
        display = source[start:end]
        show_url = next(line for line in source.splitlines() if line.startswith("show_url()"))
        with tempfile.TemporaryDirectory(prefix="tob-prompt-") as directory:
            target_file = Path(directory) / "deployment.env"
            target_file.write_text("WORKOS_ENVIRONMENT_ID=environment_Synthetic01\n")
            # This file is deliberately never created or opened.
            secret_path = str(Path(directory) / "private folder" / "secrets.env")
            for locale in (None, "C"):
                with self.subTest(locale=locale):
                    env = dict(os.environ, ENV_FILE=str(target_file), TOB_SECRET_FILE=secret_path)
                    if locale is not None:
                        env["LC_ALL"] = locale
                    result = subprocess.run(
                        [os.environ.get("TOB_TEST_BASH", "/bin/bash"), "-c",
                         library + "\n" + show_url + "\nTOTAL_STAGES=4\n_STAGE_INDEX=2\n" + display],
                        stdin=subprocess.DEVNULL, capture_output=True, env=env,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
                    output = result.stdout.decode("utf-8")
                    self.assertIn("Stage 3/4", output)
                    self.assertIn("秘密仅保存到：" + secret_path + "（0600，仓库外）", output)
                    self.assertFalse(Path(secret_path).exists())

    def test_authored_prompts_delimit_variables_before_non_ascii(self):
        authored = SCRIPT.read_text().split("# STAGES: author this section.", 1)[1]
        ambiguous = re.findall(r"\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])", authored)
        self.assertEqual(ambiguous, [], "Use ${variable} before non-ASCII punctuation")


if __name__ == "__main__":
    unittest.main()
