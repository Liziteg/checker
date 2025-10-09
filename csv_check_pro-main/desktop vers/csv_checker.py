"""Graphical CSV comparison tool.

This module provides functionality to compare two CSV files by a key field
and highlight any differences. It also exposes a Tkinter based GUI for
interactive usage.
"""
from __future__ import annotations

import csv
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Set

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


@dataclass(frozen=True)
class Difference:
    """Represents a difference between two CSV files."""

    POLICY_NO: str
    column: str
    value_a: str
    value_b: str
    difference_type: str

    @property
    def policy_no(self) -> str:
        """Backward compatible alias for the policy number field."""

        return self.POLICY_NO


VALUE_MISMATCH = "value_mismatch"
MISSING_IN_A = "missing_in_a"
MISSING_IN_B = "missing_in_b"


class CsvComparisonError(Exception):
    """Custom exception for CSV comparison errors."""


def read_csv_sorted(file_path: str, key_field: str) -> List[Dict[str, str]]:
    """Read a CSV file, ensuring the key field exists, and return sorted rows."""
    if not os.path.exists(file_path):
        raise CsvComparisonError(f"Файл не найден: {file_path}")

    with open(file_path, "r", encoding="utf-8-sig", newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        if reader.fieldnames is None:
            raise CsvComparisonError("CSV файл не содержит заголовков.")

        actual_key_field = _resolve_key_field(reader.fieldnames, key_field, file_path)

        rows = []
        for row in reader:
            if actual_key_field != key_field:
                value = row.pop(actual_key_field, "")
                row[key_field] = value
            rows.append(row)

    try:
        rows.sort(key=lambda row: row.get(key_field, ""))
    except TypeError as error:
        raise CsvComparisonError(
            "Ошибка сортировки. Проверьте корректность значений в столбце ключа."
        ) from error

    return rows


def _resolve_key_field(
    fieldnames: Sequence[str], key_field: str, file_path: str
) -> str:
    """Return actual column name that matches the provided key (case insensitive)."""

    for field in fieldnames:
        if field == key_field:
            return field
    key_lower = key_field.casefold()
    for field in fieldnames:
        if field.casefold() == key_lower:
            return field

    raise CsvComparisonError(
        f"В файле {file_path} отсутствует ключевой столбец '{key_field}'."
    )


def detect_duplicate_keys(rows: Iterable[Dict[str, str]], key_field: str) -> List[str]:
    """Return a list of duplicate key values."""
    occurrences: Dict[str, int] = defaultdict(int)
    duplicates: List[str] = []
    for row in rows:
        key_value = row.get(key_field, "")
        occurrences[key_value] += 1
        if occurrences[key_value] == 2:
            duplicates.append(key_value)
    return duplicates


FIELD_REPORT_HEADERS = (
    "Поле",
    "Всего расхождений",
    "Несовпадений значений",
    "Отсутствует в файле 1",
    "Отсутствует в файле 2",
)


def summarize_differences_by_field(
    differences: Sequence[Difference],
) -> List[Dict[str, str]]:
    """Group differences by column and return rows for report generation."""

    summary: Dict[str, Counter] = defaultdict(Counter)
    for diff in differences:
        field_name = diff.column if diff.column != "__missing__" else "Строка отсутствует"
        summary[field_name][diff.difference_type] += 1

    report_rows: List[Dict[str, str]] = []
    for field_name in sorted(summary.keys()):
        counts = summary[field_name]
        total = sum(counts.values())
        report_rows.append(
            {
                FIELD_REPORT_HEADERS[0]: field_name,
                FIELD_REPORT_HEADERS[1]: str(total),
                FIELD_REPORT_HEADERS[2]: str(counts.get(VALUE_MISMATCH, 0)),
                FIELD_REPORT_HEADERS[3]: str(counts.get(MISSING_IN_A, 0)),
                FIELD_REPORT_HEADERS[4]: str(counts.get(MISSING_IN_B, 0)),
            }
        )
    return report_rows


def write_field_report(
    differences: Sequence[Difference],
    output_path: str,
) -> None:
    """Persist aggregated difference information to CSV."""

    if not output_path:
        raise CsvComparisonError("Не указан путь для сохранения отчёта.")

    report_rows = summarize_differences_by_field(differences)
    if not report_rows:
        raise CsvComparisonError("Отчёт нельзя сохранить: различия отсутствуют.")

    with open(output_path, "w", encoding="utf-8", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=FIELD_REPORT_HEADERS)
        writer.writeheader()
        writer.writerows(report_rows)


def compare_csv_files(
    file_path_a: str,
    file_path_b: str,
    key_field: str = "POLICY_NO",
) -> List[Difference]:
    """Compare two CSV files and return a list of differences."""
    rows_a = read_csv_sorted(file_path_a, key_field)
    rows_b = read_csv_sorted(file_path_b, key_field)

    duplicates_a = detect_duplicate_keys(rows_a, key_field)
    duplicates_b = detect_duplicate_keys(rows_b, key_field)
    if duplicates_a or duplicates_b:
        duplicates_info = []
        if duplicates_a:
            duplicates_info.append(
                f"Файл {os.path.basename(file_path_a)} содержит дубликаты ключей: {', '.join(duplicates_a)}"
            )
        if duplicates_b:
            duplicates_info.append(
                f"Файл {os.path.basename(file_path_b)} содержит дубликаты ключей: {', '.join(duplicates_b)}"
            )
        raise CsvComparisonError("\n".join(duplicates_info))

    lookup_a = {row[key_field]: row for row in rows_a}
    lookup_b = {row[key_field]: row for row in rows_b}

    all_keys = sorted(set(lookup_a) | set(lookup_b))
    def collect_columns(rows: Sequence[Dict[str, str]]) -> Set[str]:
        columns: Set[str] = set()
        for row in rows:
            columns.update(row.keys())
        return columns

    columns_a = collect_columns(rows_a)
    columns_b = collect_columns(rows_b)
    all_columns = list(sorted(columns_a | columns_b))

    def row_preview(row: Dict[str, str]) -> str:
        """Build a short description of row values excluding the key."""

        parts: List[str] = []
        for column in all_columns:
            if column == key_field:
                continue
            value = row.get(column, "")
            if value:
                parts.append(f"{column}={value}")
        return ", ".join(parts) if parts else "данные отсутствуют"

    differences: List[Difference] = []
    for key in all_keys:
        row_a = lookup_a.get(key)
        row_b = lookup_b.get(key)
        if row_a is None:
            differences.append(
                Difference(
                    POLICY_NO=key,
                    column="__missing__",
                    value_a=f"Нет записи в {os.path.basename(file_path_a)}",
                    value_b=(
                        f"Данные файла 2: {row_preview(row_b)}" if row_b else "—"
                    ),
                    difference_type=MISSING_IN_A,
                )
            )
            continue
        if row_b is None:
            differences.append(
                Difference(
                    POLICY_NO=key,
                    column="__missing__",
                    value_a=f"Данные файла 1: {row_preview(row_a)}",
                    value_b=f"Нет записи в {os.path.basename(file_path_b)}",
                    difference_type=MISSING_IN_B,
                )
            )
            continue

        for column in all_columns:
            if column == key_field:
                continue
            value_a = row_a.get(column, "") or ""
            value_b = row_b.get(column, "") or ""
            if value_a != value_b:
                differences.append(
                    Difference(
                        POLICY_NO=key,
                        column=column,
                        value_a=value_a,
                        value_b=value_b,
                        difference_type=VALUE_MISMATCH,
                    )
                )

    return differences


class CsvComparatorApp(tk.Tk):
    """Tkinter based GUI application for comparing CSV files."""

    def __init__(self) -> None:
        super().__init__()
        self.title("Сравнение CSV")
        self.geometry("1000x600")
        self.minsize(700, 500)

        self.file_path_a = tk.StringVar()
        self.file_path_b = tk.StringVar()
        self.key_field = tk.StringVar(value="POLICY_NO")
        self.differences: List[Difference] = []
        self.last_file_name_a = ""
        self.last_file_name_b = ""

        self._build_ui()

    def _build_ui(self) -> None:
        """Construct the widgets for the application."""
        main_frame = ttk.Frame(self, padding=10)
        main_frame.pack(fill=tk.BOTH, expand=True)

        file_frame = ttk.Frame(main_frame)
        file_frame.pack(fill=tk.X, pady=(0, 10))

        self._add_file_selector(file_frame, "Файл 1", self.file_path_a, 0)
        self._add_file_selector(file_frame, "Файл 2", self.file_path_b, 1)

        key_frame = ttk.Frame(main_frame)
        key_frame.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(key_frame, text="Ключевой столбец:").pack(side=tk.LEFT)
        ttk.Entry(key_frame, textvariable=self.key_field, width=30).pack(
            side=tk.LEFT, padx=(5, 0)
        )

        self.report_button = ttk.Button(
            key_frame,
            text="Сохранить отчёт",
            command=self.export_report,
            state=tk.DISABLED,
        )
        self.report_button.pack(side=tk.RIGHT)

        ttk.Button(
            key_frame,
            text="Сравнить",
            command=self.compare_and_display,
        ).pack(side=tk.RIGHT, padx=(10, 10))

        columns = ("POLICY_NO", "column", "difference", "value_a", "value_b")
        self.tree = ttk.Treeview(
            main_frame,
            columns=columns,
            show="headings",
        )
        self.headings = {
            "POLICY_NO": "POLICY_NO",
            "column": "Поле",
            "difference": "Тип различия",
            "value_a": "Значение файла 1",
            "value_b": "Значение файла 2",
        }
        for column in columns:
            self.tree.heading(column, text=self.headings[column])
            self.tree.column(column, anchor=tk.W, stretch=True)

        self.tree.tag_configure(
            VALUE_MISMATCH,
            background="#fdecea",
            foreground="#c0392b",
        )
        self.tree.tag_configure(
            MISSING_IN_A,
            background="#e8f6f3",
            foreground="#0b5345",
        )
        self.tree.tag_configure(
            MISSING_IN_B,
            background="#ebf5fb",
            foreground="#1a5276",
        )

        scrollbar = ttk.Scrollbar(
            main_frame, orient=tk.VERTICAL, command=self.tree.yview
        )
        self.tree.configure(yscrollcommand=scrollbar.set)

        self.tree.pack(fill=tk.BOTH, expand=True, side=tk.LEFT)
        scrollbar.pack(fill=tk.Y, side=tk.RIGHT)

        self.status_label = ttk.Label(main_frame, text="")
        self.status_label.pack(fill=tk.X, pady=(10, 0))

    def _add_file_selector(
        self,
        parent: ttk.Frame,
        label_text: str,
        variable: tk.StringVar,
        row: int,
    ) -> None:
        """Add labeled entry with a button to choose a file."""
        row_frame = ttk.Frame(parent)
        row_frame.grid(row=row, column=0, sticky=tk.W + tk.E, pady=5)
        row_frame.columnconfigure(1, weight=1)

        ttk.Label(row_frame, text=label_text, width=12).grid(row=0, column=0, sticky=tk.W)
        entry = ttk.Entry(row_frame, textvariable=variable)
        entry.grid(row=0, column=1, sticky=tk.W + tk.E, padx=(5, 5))
        ttk.Button(
            row_frame,
            text="Выбрать...",
            command=lambda: self._select_file(variable),
        ).grid(row=0, column=2, sticky=tk.E)

    def _select_file(self, variable: tk.StringVar) -> None:
        """Open a file dialog and update the variable with the chosen path."""
        file_path = filedialog.askopenfilename(
            title="Выбор CSV файла",
            filetypes=(("CSV файлы", "*.csv"), ("Все файлы", "*.*")),
        )
        if file_path:
            variable.set(file_path)

    def compare_and_display(self) -> None:
        """Run comparison and display results in the treeview."""
        file_a = self.file_path_a.get().strip()
        file_b = self.file_path_b.get().strip()
        key_field = self.key_field.get().strip()

        if not file_a or not file_b:
            messagebox.showwarning("Внимание", "Укажите пути к обоим файлам.")
            return
        if not key_field:
            messagebox.showwarning("Внимание", "Укажите ключевой столбец.")
            return

        try:
            differences = compare_csv_files(file_a, file_b, key_field)
        except CsvComparisonError as error:
            self.differences = []
            self.report_button.config(state=tk.DISABLED)
            messagebox.showerror("Ошибка", str(error))
            return
        except Exception as error:  # pragma: no cover - защитный блок
            self.differences = []
            self.report_button.config(state=tk.DISABLED)
            messagebox.showerror("Ошибка", f"Непредвиденная ошибка: {error}")
            return

        self.differences = list(differences)
        self.last_file_name_a = os.path.basename(file_a)
        self.last_file_name_b = os.path.basename(file_b)
        self._populate_tree(self.differences, self.last_file_name_a, self.last_file_name_b)

    def _populate_tree(
        self,
        differences: Sequence[Difference],
        file_name_a: str,
        file_name_b: str,
    ) -> None:
        """Fill the treeview with comparison results."""
        for item in self.tree.get_children():
            self.tree.delete(item)

        if not differences:
            self.report_button.config(state=tk.DISABLED)
            self.status_label.config(
                text=(
                    "Различий не обнаружено. "
                    f"Файл 1: {file_name_a}. Файл 2: {file_name_b}."
                )
            )
            self.tree.heading("value_a", text=self.headings["value_a"])
            self.tree.heading("value_b", text=self.headings["value_b"])
            return

        self.tree.heading("value_a", text=f"Значение {file_name_a}")
        self.tree.heading("value_b", text=f"Значение {file_name_b}")
        self.report_button.config(state=tk.NORMAL)

        for diff in differences:
            column_label = (
                "Строка отсутствует" if diff.column == "__missing__" else diff.column
            )
            difference_label = self._format_difference_label(diff)
            self.tree.insert(
                "",
                tk.END,
                values=(
                    diff.POLICY_NO,
                    column_label,
                    difference_label,
                    diff.value_a,
                    diff.value_b,
                ),
                tags=(diff.difference_type,),
            )

        self._update_status(differences, file_name_a, file_name_b)

    def _format_difference_label(self, diff: Difference) -> str:
        """Return a human readable label for a difference."""

        if diff.difference_type == VALUE_MISMATCH:
            return "Несовпадение значений"
        if diff.difference_type == MISSING_IN_A:
            return "Нет строки в файле 1"
        if diff.difference_type == MISSING_IN_B:
            return "Нет строки в файле 2"
        return "Различие"

    def _update_status(
        self,
        differences: Sequence[Difference],
        file_name_a: str,
        file_name_b: str,
    ) -> None:
        """Update summary label with aggregated difference counts."""

        type_counts = Counter(diff.difference_type for diff in differences)
        details: List[str] = []
        if type_counts.get(VALUE_MISMATCH):
            details.append(
                f"несовпадений значений — {type_counts[VALUE_MISMATCH]}"
            )
        if type_counts.get(MISSING_IN_A):
            details.append(f"нет строк в файле 1 — {type_counts[MISSING_IN_A]}")
        if type_counts.get(MISSING_IN_B):
            details.append(f"нет строк в файле 2 — {type_counts[MISSING_IN_B]}")

        details_text = "; ".join(details)
        base_text = (
            f"Всего различий: {len(differences)}. "
            f"Файл 1: {file_name_a}. Файл 2: {file_name_b}."
        )
        if details_text:
            base_text = f"{base_text} Детализация: {details_text}."
        self.status_label.config(text=base_text)

    def export_report(self) -> None:
        """Save aggregated report to CSV."""

        if not self.differences:
            messagebox.showinfo(
                "Отчёт",
                "Сначала выполните сравнение, чтобы сохранить отчёт.",
            )
            return

        file_path = filedialog.asksaveasfilename(
            title="Сохранить отчёт",
            defaultextension=".csv",
            filetypes=(("CSV файлы", "*.csv"), ("Все файлы", "*.*")),
        )
        if not file_path:
            return

        try:
            write_field_report(self.differences, file_path)
        except CsvComparisonError as error:
            messagebox.showerror("Ошибка", str(error))
            return
        except OSError as error:
            messagebox.showerror(
                "Ошибка",
                f"Не удалось сохранить отчёт: {error}",
            )
            return

        messagebox.showinfo("Готово", f"Отчёт сохранён: {file_path}")


def run_app() -> None:
    """Launch the GUI application."""
    app = CsvComparatorApp()
    app.mainloop()


if __name__ == "__main__":
    run_app()
