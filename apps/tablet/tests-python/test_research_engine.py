import json
import math
from pathlib import Path
import tempfile
import unittest
import sys

# Support both root pytest collection and standalone unittest discovery.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine-src'))

from research_engine import (EngineConfig, Rules, compress, evaluate, load_rules,
                             main, rank01, run, split_sentences, verify)


class EngineTests(unittest.TestCase):
    def test_noise_not_rescued_by_weak_anchor_or_section(self):
        result = run("## 잡담\n참고로 지난주 7만 원 건은 정산이 끝났습니다.\n## 개발\nDocker 서버를 이전합니다.", cfg=EngineConfig(ratio=1))
        self.assertEqual(result.selected_ids, [1])
        self.assertTrue(result.sentences[0].weak)
        self.assertTrue(result.sentences[0].noise)
        self.assertTrue(any("only 0" in w for w in result.warnings))

    def test_strong_anchor_overrides_noise(self):
        result = run("참고로 Docker 서버를 이전합니다.")
        self.assertTrue(result.sentences[0].strong)
        self.assertFalse(result.sentences[0].noise)
        self.assertEqual(result.selected_ids, [0])

    def test_keyword_boundaries(self):
        result = run("CAPITAL 비용을 산정합니다.\nAPI를 도입합니다.", cfg=EngineConfig(ratio=1))
        self.assertFalse(result.sentences[0].strong)
        self.assertTrue(result.sentences[1].strong)

    def test_life_retains_meals_and_settlement(self):
        result = run("점심 식사는 12시입니다.\n참고로 7만 원 정산을 마쳤습니다.", rules=load_rules("life"), cfg=EngineConfig(ratio=1))
        self.assertEqual(result.selected_ids, [0, 1])

    def test_legal_patterns(self):
        result = run("제 750 조에 따라 청구합니다.\n2025가합12345 사건입니다.", rules=load_rules("legal"), cfg=EngineConfig(ratio=1))
        self.assertTrue(all(s.strong for s in result.sentences))

    def test_original_context_passed_to_callbacks_including_noise(self):
        seen = {}
        def embed(texts):
            seen["embed"] = texts
            return [[1, 0]] * len(texts)
        def surprisal(texts):
            seen["surprisal"] = texts
            return [1] * len(texts)
        run("## 제목\n점심은 맛있었습니다.\nDocker 이전입니다.", "이전", embed_fn=embed, surprisal_fn=surprisal)
        self.assertIn("점심은 맛있었습니다.", seen["embed"])
        self.assertEqual(seen["surprisal"], ["점심은 맛있었습니다.", "Docker 이전입니다."])
        self.assertEqual(seen["embed"][-2:], ["이전", "## 제목"])

    def test_absolute_floor_beats_anchors_slots_and_rank(self):
        def embed(texts):
            return [[0, 1]] * (len(texts) - 1) + [[1, 0]]
        result = run("Docker 이전입니다.\nAPI 도입입니다.", "요리", embed_fn=embed, cfg=EngineConfig(min_cos=0.2))
        self.assertEqual(result.selected_ids, [])

    def test_multiplicative_gate_suppresses_irrelevant_surprise(self):
        def embed(texts):
            return [[1, 0], [0, 1], [1, 0]]
        rules = Rules("test", structure={"min_per_section": 0})
        result = run("관련 내용입니다.\n무관 내용입니다.", "질의", rules, EngineConfig(ratio=0.5), embed_fn=embed, surprisal_fn=lambda _: [0, 100])
        self.assertEqual(result.selected_ids, [0])
        self.assertLess(result.sentences[1].score, 0.01)

    def test_odd_budget_anchor_cap_is_not_rounded_up(self):
        result = run("Docker 도입입니다.\nAPI 변경입니다.\nMySQL 이전입니다.", cfg=EngineConfig(ratio=1))
        self.assertEqual(result.metadata["forced_count"], 1)

    def test_mmr_prefers_distinct_content(self):
        def embed(texts):
            return [[1, 0], [1, 0], [0, 1], [1, 1]]
        rules = Rules("test", structure={"min_per_section": 0}, max_forced_ratio=0)
        result = run("첫 내용입니다.\n반복 내용입니다.\n새 내용입니다.", "질의", rules, EngineConfig(max_sentences=2, mmr_lambda=0.4), embed_fn=embed, surprisal_fn=lambda _: [1, 1, 1])
        self.assertEqual(result.selected_ids, [0, 2])

    def test_slots_expand_budget_explicitly(self):
        result = run("## 하나\nDocker 이전입니다.\n## 둘\nAPI 도입입니다.", cfg=EngineConfig(max_sentences=1))
        self.assertEqual(result.budget, 1)
        self.assertEqual(result.selected_ids, [0, 1])
        self.assertTrue(any("coverage expanded" in w for w in result.warnings))

    def test_slots_replace_surplus_before_expanding_budget(self):
        result = run("## 하나\nDocker 이전입니다.\nAPI 변경입니다.\n## 둘\n새 일정을 정합니다.",
                     cfg=EngineConfig(max_sentences=2),
                     embed_fn=lambda texts: [[1, 0], [1, 0], [0, 1]] + [[1, 0]] * (len(texts) - 3))
        self.assertEqual(len(result.selected_ids), 2)
        self.assertIn(2, result.selected_ids)

    def test_evaluation_reports_compression_failure_and_fallback(self):
        report = evaluate([{"text": "Docker 16입니다.", "must_include": [0]}], llm_fn=lambda _: "Docker 17입니다.")
        self.assertEqual(report["verification_failure_rate"], 1)
        self.assertEqual(report["fallback_rate"], 1)

    def test_reference_restores_predecessor_in_source_order(self):
        result = run("기반을 정비합니다.\n이를 위해 Docker를 도입합니다.", cfg=EngineConfig(max_sentences=1))
        self.assertEqual(result.selected_ids, [0, 1])
        self.assertIn("context_repair", result.sentences[0].reasons)

    def test_repair_does_not_reintroduce_noise(self):
        result = run("점심은 맛있었습니다.\n이를 위해 Docker를 도입합니다.", cfg=EngineConfig(max_sentences=1))
        self.assertEqual(result.selected_ids, [1])
        self.assertTrue(any("reference unresolved" in w for w in result.warnings))

    def test_repair_does_not_cross_section(self):
        result = run("## 하나\n기반을 정비합니다.\n## 둘\n이를 위해 Docker를 도입합니다.", cfg=EngineConfig(max_sentences=1), rules=Rules("test", positive={"keywords": ["Docker"]}, structure={"min_per_section": 0}))
        self.assertEqual(result.selected_ids, [1])
        self.assertTrue(any("section boundary" in w for w in result.warnings))

    def test_header_and_decimal_split(self):
        sentences = split_sentences("# 제목\n1. 단계\nPostgreSQL 16.2를 씁니다. 다음 작업입니다.\n가. 검증\n검증합니다.")
        self.assertEqual(len(sentences), 3)
        self.assertIn("16.2", sentences[0].text)
        self.assertTrue(sentences[0].position)
        self.assertFalse(sentences[1].position)
        self.assertTrue(sentences[2].position)

    def test_empty_singleton_ties(self):
        self.assertEqual(run("").selected_ids, [])
        self.assertEqual(run("## 제목").selected_ids, [])
        self.assertEqual(run("한 문장입니다.").selected_ids, [0])
        self.assertEqual(rank01([1, 1, 1]), [0.5, 0.5, 0.5])
        self.assertEqual(rank01([0, 0, 1]), [0.25, 0.25, 1])

    def test_invalid_model_outputs_fail_loudly(self):
        for callback in (lambda _: [], lambda _: [[math.nan]], lambda _: [[1], [1, 2]]):
            with self.assertRaises(ValueError):
                run("한 문장입니다.", embed_fn=callback)
        for callback in (lambda _: [], lambda _: [math.inf]):
            with self.assertRaises(ValueError):
                run("한 문장입니다.", surprisal_fn=callback)

    def test_config_validation(self):
        for kwargs in ({"ratio": 0}, {"ratio": math.nan}, {"gate_temp": 0}, {"max_sentences": -1}, {"max_sentences": 1.5}, {"min_cos": 2}, {"mmr_lambda": 2}, {"context_window": -1}):
            with self.assertRaises(ValueError):
                EngineConfig(**kwargs)

    def test_builtins_and_files_match(self):
        for profile in ("dev", "legal", "life"):
            self.assertEqual(load_rules(profile), load_rules(path=Path(__file__).resolve().parents[1] / "rules" / f"{profile}.yaml"))

    def test_rule_validation(self):
        with self.assertRaises(ValueError):
            Rules("bad", negative_disable=["missing"])
        with self.assertRaises(ValueError):
            Rules("bad", positive={"keywords": "Docker"})

    def test_compression_retries_version_hallucination_then_falls_back(self):
        source = "PostgreSQL 16으로 이전합니다."
        calls = []
        def llm(prompt):
            calls.append(prompt)
            return "PostgreSQL 17으로 이전합니다."
        result = compress(source, llm)
        self.assertEqual(len(calls), 2)
        self.assertTrue(result["fallback"])
        self.assertEqual(result["summary"], source)
        self.assertIn("17", result["checks"][0]["invented"])
        self.assertTrue(result["verify"]["ok"])

    def test_retry_can_succeed(self):
        responses = iter(["PostgreSQL 17입니다.", "PostgreSQL 16입니다."])
        result = compress("PostgreSQL 16입니다.", lambda _: next(responses))
        self.assertFalse(result["fallback"])
        self.assertEqual(result["attempts"], 2)

    def test_new_korean_name_and_units_and_empty_are_rejected(self):
        self.assertFalse(verify("김철수가 2시간 진행합니다.", "박영희가 2시간 진행합니다.")["ok"])
        self.assertFalse(verify("2시간", "2개월")["ok"])
        self.assertFalse(verify("PostgreSQL", "MySQL")["ok"])
        self.assertFalse(verify("본문", "")["ok"])

    def test_provider_failure_falls_back_without_leaking_error(self):
        def llm(_):
            raise RuntimeError("secret-token")
        result = compress("본문입니다.", llm)
        self.assertEqual(result["errors"], ["RuntimeError", "RuntimeError"])
        self.assertNotIn("secret-token", json.dumps(result))

    def test_no_model_is_zero_call_fallback(self):
        result = compress("본문입니다.")
        self.assertEqual(result["attempts"], 0)
        self.assertTrue(result["fallback"])

    def test_evaluation_checks_labels_and_reports_metrics(self):
        cases = [{"text": "Docker 이전입니다.\n점심은 맛있었습니다.", "must_include": [0], "must_exclude": [1]}]
        report = evaluate(cases)
        self.assertEqual(report["core_recall"], 1)
        self.assertEqual(report["noise_inclusion_rate"], 0)
        with self.assertRaises(ValueError):
            evaluate([{**cases[0], "must_include": [5]}])

    def test_cli_writes_utf8_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "입력.txt", Path(folder) / "결과.json"
            source.write_text("Docker 이전입니다.", encoding="utf-8")
            self.assertEqual(main([str(source), "--json", "--output", str(output)]), 0)
            data = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(data["selected_ids"], [0])


if __name__ == "__main__":
    unittest.main()
