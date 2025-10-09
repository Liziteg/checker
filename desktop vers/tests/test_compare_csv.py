import csv
import os
import tempfile
import unittest

from csv_checker import (
    Difference,
    CsvComparisonError,
    compare_csv_files,
    summarize_differences_by_field,
    write_field_report,
)


class CompareCsvFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_files = []

    def tearDown(self) -> None:
        for file_path in self.temp_files:
            if os.path.exists(file_path):
                os.remove(file_path)

    def _create_csv(self, headers, rows):
        temp_file = tempfile.NamedTemporaryFile("w", delete=False, newline="", encoding="utf-8")
        writer = csv.writer(temp_file)
        writer.writerow(headers)
        writer.writerows(rows)
        temp_file.close()
        self.temp_files.append(temp_file.name)
        return temp_file.name

    def test_detects_value_differences(self):
        headers = ["Policy_no", "Amount", "Status"]
        file_a = self._create_csv(headers, [["001", "100", "Active"], ["002", "200", "Active"]])
        file_b = self._create_csv(headers, [["001", "150", "Active"], ["002", "200", "Closed"]])

        differences = compare_csv_files(file_a, file_b)
        self.assertEqual(len(differences), 2)

        diff_columns = {(d.policy_no, d.column) for d in differences}
        self.assertIn(("001", "Amount"), diff_columns)
        self.assertIn(("002", "Status"), diff_columns)
        self.assertTrue(all(d.difference_type == "value_mismatch" for d in differences))

    def test_detects_missing_rows(self):
        headers = ["Policy_no", "Amount"]
        file_a = self._create_csv(headers, [["001", "100"]])
        file_b = self._create_csv(headers, [["001", "100"], ["002", "200"]])

        differences = compare_csv_files(file_a, file_b)
        self.assertEqual(len(differences), 1)
        self.assertEqual(differences[0].policy_no, "002")
        self.assertEqual(differences[0].column, "__missing__")
        self.assertEqual(differences[0].difference_type, "missing_in_a")

    def test_raises_on_duplicate_keys(self):
        headers = ["Policy_no", "Amount"]
        file_a = self._create_csv(headers, [["001", "100"], ["001", "150"]])
        file_b = self._create_csv(headers, [["001", "100"]])

        with self.assertRaises(CsvComparisonError):
            compare_csv_files(file_a, file_b)

    def test_summarize_differences_by_field(self):
        differences = [
            Difference("001", "Amount", "100", "120", "value_mismatch"),
            Difference("001", "Status", "Active", "Closed", "value_mismatch"),
            Difference("002", "__missing__", "Нет записи в A", "Данные файла 2", "missing_in_a"),
        ]

        summary = summarize_differences_by_field(differences)
        summary_map = {row["Поле"]: row for row in summary}
        self.assertEqual(summary_map["Amount"]["Несовпадений значений"], "1")
        self.assertEqual(summary_map["Status"]["Несовпадений значений"], "1")
        self.assertEqual(
            summary_map["Строка отсутствует"]["Отсутствует в файле 1"],
            "1",
        )

    def test_write_field_report(self):
        differences = [
            Difference("001", "Amount", "100", "120", "value_mismatch"),
            Difference("002", "__missing__", "Нет записи", "Данные", "missing_in_b"),
        ]

        temp_file = tempfile.NamedTemporaryFile(
            "w", delete=False, newline="", encoding="utf-8"
        )
        temp_file.close()
        self.temp_files.append(temp_file.name)

        write_field_report(differences, temp_file.name)

        with open(temp_file.name, encoding="utf-8") as report_file:
            reader = csv.DictReader(report_file)
            rows = list(reader)
        self.assertEqual(len(rows), 2)
        fields = {row["Поле"] for row in rows}
        self.assertIn("Amount", fields)
        self.assertIn("Строка отсутствует", fields)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
