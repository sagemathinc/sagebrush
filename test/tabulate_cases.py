from tabulate import tabulate


rows = [
    ["alpha", 1, 2.5],
    ["beta", 1200, None],
    ["gamma", -3, 4.125],
]
headers = ["label", "count", "value"]
print(tabulate(rows, headers, tablefmt="fancy_grid"))
