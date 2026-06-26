---
title: Export Test Deck
date: 2026-06-26T00:00:00.000Z
---

# Export Test

Covers tables, references, code, math, and mixed layouts.

---

## Basic Table

| Name | Role | Status |
|------|------|--------|
| Alice | Engineer | Active |
| Bob | Designer | Active |
| Carol | Manager | On Leave |

---

## Table with Empty Cells

| Feature | v1 | v2 | v3 |
|---------|----|----|-----|
| Export | ✓ | ✓ | ✓ |
| Import |   | ✓ | ✓ |
| Themes |   |    | ✓ |
| Refs   |   |    |    |

---

## Wide Table (overflow test)

| Quarter |: Revenue :| Expenses | Net | Growth | Notes |
|---------|:---------:|----------:|-----:|--------|-------|
| Q1 2024 | $1.2M | $0.9M | $0.3M | — | Baseline |
| Q2 2024 | $1.5M | $1.0M | $0.5M | +67% | Strong |
| Q3 2024 | $1.4M | $1.1M | $0.3M | -40% | Flat |
| Q4 2024 | $2.1M | $1.3M | $0.8M | +167% | Record |
| Q1 2025 | $1.8M | $1.2M | $0.6M | -25% | Seasonal |
| Q2 2025 | $2.3M | $1.4M | $0.9M | +50% | Growing |

---

## Table with References

| Study | Year | Findings |
|-------|------|----------|
| Smith et al. | 2022 | Positive correlation |
| Jones & Lee | 2023 | No significant effect |
| Wu et al. | 2024 | Mixed results |

!ref[Smith, A. et al. (2022). Journal of Results, 14(2), 45–60.]
!ref[Jones, B. & Lee, C. (2023). Annual Review, 8, 112–130.]

---

## Code Slide

```python
def fibonacci(n: int) -> list[int]:
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq[:n]

print(fibonacci(10))
```

---

## Two-Column: Text + Table

Here is some context about the data on the right.

- Key metric: revenue
- Timeframe: annual
- Currency: USD

|||

| Year | Revenue |
|------|---------|
| 2022 | $800K |
| 2023 | $1.2M |
| 2024 | $2.1M |

---

## Math Slide

$$E = mc^2$$

The energy $E$ equals mass $m$ times the speed of light $c$ squared.

---

> The best way to predict the future is to invent it.
> — Alan Kay

---

## References Slide

Key citations for this presentation.

!ref[Knuth, D. (1997). The Art of Computer Programming. Addison-Wesley.]
!ref[Dijkstra, E. (1968). Go To Statement Considered Harmful. CACM, 11(3).]
!ref[Brooks, F. (1975). The Mythical Man-Month. Addison-Wesley.]
