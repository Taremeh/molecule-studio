/**
 * Inline test fixtures for the io parsers (realistic snippets; not imported by the app).
 */

/**
 * Crambin (1CRN) residues 1–3 with: TITLE continuation, COMPND, a HELIX (THR 2–CYS 3) and a SHEET
 * (THR 1) record, altLocs A/B on THR 2 CB/OG1, HETATMs without element columns (Zn, Cl), a charged
 * Ca²⁺ ion, a water, a second MODEL (must be ignored) and duplicated / dangling CONECT records.
 */
export const PDB_FIXTURE = `HEADER    PLANT PROTEIN                           30-APR-81   1CRN
TITLE     WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION.
TITLE    2 PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN
COMPND    MOL_ID: 1;
COMPND   2 MOLECULE: CRAMBIN;
HELIX    1  H1 THR A    2  CYS A    3  13/10 CONFORMATION RES 17,19        2
SHEET    1  S1 2 THR A   1  THR A   1  0
MODEL        1
ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N
ATOM      2  CA  THR A   1      16.967  12.784   4.338  1.00 10.80           C
ATOM      3  C   THR A   1      15.685  12.755   5.133  1.00  9.19           C
ATOM      4  O   THR A   1      15.268  13.825   5.594  1.00  9.85           O
ATOM      5  CB  THR A   1      18.170  12.703   5.337  1.00 13.02           C
ATOM      6  OG1 THR A   1      19.334  12.829   4.463  1.00 15.06           O
ATOM      7  CG2 THR A   1      18.150  11.546   6.304  1.00 14.23           C
ATOM      8  N   THR A   2      15.115  11.555   5.265  1.00  7.81           N
ATOM      9  CA  THR A   2      13.856  11.469   6.066  1.00  8.31           C
ATOM     10  C   THR A   2      14.164  10.785   7.379  1.00  5.80           C
ATOM     11  O   THR A   2      14.993   9.862   7.443  1.00  6.94           O
ATOM     12  CB ATHR A   2      12.732  10.711   5.261  0.60 10.32           C
ATOM    112  CB BTHR A   2      13.232  10.711   5.261  0.40 10.32           C
ATOM     13  OG1ATHR A   2      13.308   9.439   4.926  0.60 12.81           O
ATOM    113  OG1BTHR A   2      13.808   9.439   4.926  0.40 12.81           O
ATOM     14  CG2 THR A   2      12.484  11.442   3.895  1.00 11.90           C
ATOM     15  N   CYS A   3      13.488  11.241   8.417  1.00  5.24           N
ATOM     16  CA  CYS A   3      13.660  10.707   9.787  1.00  5.39           C
ATOM     17  C   CYS A   3      12.269  10.431  10.323  1.00  4.45           C
ATOM     18  O   CYS A   3      11.393  11.308  10.185  1.00  6.54           O
ATOM     19  CB  CYS A   3      14.368  11.748  10.691  1.00  5.99           C
ATOM     20  SG  CYS A   3      15.885  12.426  10.016  1.00  7.01           S
HETATM   21 ZN    ZN A 101      16.500  13.000  11.500  1.00 10.00
HETATM   22  O   HOH A 201      20.857  43.192  21.450  1.00 63.07           O
HETATM   23 CL1  LIG A 301      10.000  10.000  10.000  1.00 20.00
HETATM   24 CA    CA A 401       5.000   5.000   5.000  1.00 20.00          CA2+
ENDMDL
MODEL        2
ATOM      1  N   THR A   1      99.000  14.099   3.625  1.00 13.79           N
ENDMDL
CONECT   20   21
CONECT   21   20  999
CONECT   20   21
END
`;

/**
 * mmCIF: _entry/_struct pairs, a ;-delimited multi-line title containing quotes, a text field whose
 * lines look like CIF syntax, struct_conf (HELX + a TURN that must be ignored), a single-row
 * struct_sheet_range written as key–value pairs, and an _atom_site loop with label/auth differences,
 * altLocs, quoted atom names (O5' written both ways), formal charges and a second model.
 */
export const CIF_FIXTURE = `data_1ABC
#
_entry.id   1ABC
#
_struct.entry_id                  1ABC
_struct.title
;Test structure: a 'quoted' title
with a continuation line
;
_struct.pdbx_descriptor           'Glycyl-seryl-lysine # not a comment'
#
_pdbx_entry_details.entry_id                 1ABC
_pdbx_entry_details.compound_details
;loop_
_fake.tag value
# this line is text, not a comment
;
#
loop_
_struct_conf.conf_type_id
_struct_conf.id
_struct_conf.beg_label_asym_id
_struct_conf.beg_label_seq_id
_struct_conf.end_label_seq_id
_struct_conf.beg_auth_asym_id
_struct_conf.beg_auth_seq_id
_struct_conf.end_auth_seq_id
_struct_conf.pdbx_beg_PDB_ins_code
_struct_conf.pdbx_end_PDB_ins_code
HELX_P     HELX_P1 A 1 2 A 11 12 ? ?
TURN_TY1_P TURN_P1 A 3 3 A 13 13 ? ?
#
_struct_sheet_range.sheet_id          AA1
_struct_sheet_range.id                1
_struct_sheet_range.beg_auth_asym_id  A
_struct_sheet_range.beg_auth_seq_id   13
_struct_sheet_range.end_auth_asym_id  A
_struct_sheet_range.end_auth_seq_id   13
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.pdbx_formal_charge
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM   1  N  N     . GLY A 1 ? 10.000 2.000  3.000 1.00 11.00 ? 11  GLY A N     1
ATOM   2  C  CA    . GLY A 1 ? 11.200 2.500  3.100 1.00 12.00 ? 11  GLY A CA    1
ATOM   3  C  C     . GLY A 1 ? 12.000 1.400  3.700 1.00 13.00 ? 11  GLY A C     1
ATOM   4  O  O     . GLY A 1 ? 11.500 0.300  3.900 1.00 14.00 ? 11  GLY A O     1
ATOM   5  N  N     . SER A 2 ? 13.300 1.700  3.900 1.00 15.00 ? 12  SER A N     1
ATOM   6  C  CA    . SER A 2 ? 14.200 0.700  4.400 1.00 15.50 ? 12  SER A CA    1
ATOM   7  C  CB    A SER A 2 ? 15.600 1.200  4.200 0.50 16.00 ? 12  SER A CB    1
ATOM   8  C  CB    B SER A 2 ? 15.700 1.300  4.300 0.50 16.00 ? 12  SER A CB    1
ATOM   9  O  OG    A SER A 2 ? 16.500 0.200  4.600 0.50 17.00 ? 12  SER A OG    1
ATOM   10 O  OG    B SER A 2 ? 16.600 0.300  4.700 0.50 17.00 ? 12  SER A OG    1
ATOM   11 N  N     . LYS A 3 ? 14.000 -0.500 4.900 1.00 18.00 ? 13  LYS A N     1
ATOM   12 N  NZ    . LYS A 3 ? 18.000 -3.000 6.000 1.00 25.00 1 13  LYS A NZ    1
HETATM 13 C  "C5'" . ATP C . ? 20.000 5.000  5.000 1.00 30.00 ? 401 ATP A "C5'" 1
HETATM 14 O  'O5''  . ATP C . ? 21.000 5.500  5.200 1.00 30.00 ? 401 ATP A 'O5''  1
HETATM 15 ZN ZN    . ZN  D . ? 0.000  0.000  0.000 1.00 9.00  2 501 ZN  A ZN    1
HETATM 16 O  O     . HOH E . ? 1.000  1.000  1.000 1.00 40.00 ? 601 HOH A O     1
ATOM   17 N  N     . GLY A 1 ? 99.000 2.000  3.000 1.00 11.00 ? 11  GLY A N     2
#
`;

/** RCSB chemical component dictionary entry (ethanol, EOH) with ideal coordinates and bond orders. */
export const CCD_FIXTURE = `data_EOH
#
_chem_comp.id                EOH
_chem_comp.name              ETHANOL
_chem_comp.type              NON-POLYMER
_chem_comp.formula           "C2 H6 O"
#
loop_
_chem_comp_atom.comp_id
_chem_comp_atom.atom_id
_chem_comp_atom.alt_atom_id
_chem_comp_atom.type_symbol
_chem_comp_atom.charge
_chem_comp_atom.model_Cartn_x
_chem_comp_atom.model_Cartn_y
_chem_comp_atom.model_Cartn_z
_chem_comp_atom.pdbx_model_Cartn_x_ideal
_chem_comp_atom.pdbx_model_Cartn_y_ideal
_chem_comp_atom.pdbx_model_Cartn_z_ideal
EOH C1  C1  C 0 -0.002 0.000 0.000 -0.445 0.384  0.000
EOH C2  C2  C 0 1.500  0.000 0.000 1.060  0.384  0.000
EOH O   O   O 0 -0.476 1.343 0.000 -0.917 -0.963 0.000
EOH HO  HO  H 0 -1.442 1.345 0.000 -1.884 -0.963 0.000
EOH H11 1H1 H 0 -0.365 -0.514 0.890 -0.808 0.898  0.890
EOH H12 2H1 H 0 -0.365 -0.514 -0.890 -0.808 0.898 -0.890
EOH H21 1H2 H 0 1.863  -1.028 0.000 1.423  1.412  0.000
EOH H22 2H2 H 0 1.863  0.514  0.890 1.423  -0.130 0.890
EOH H23 3H2 H 0 1.863  0.514  -0.890 1.423 -0.130 -0.890
#
loop_
_chem_comp_bond.comp_id
_chem_comp_bond.atom_id_1
_chem_comp_bond.atom_id_2
_chem_comp_bond.value_order
_chem_comp_bond.pdbx_aromatic_flag
EOH C1 C2  SING N
EOH C1 O   SING N
EOH C1 H11 SING N
EOH C1 H12 SING N
EOH C2 H21 SING N
EOH C2 H22 SING N
EOH C2 H23 SING N
EOH O  HO  SING N
#
`;

/** PubChem 3D record of betaine (CID 247): zwitterion with atom-block charge codes and M  CHG. */
export const BETAINE_SDF = `247
  -OEChem-11222616503D

 19 18  0     0  0  0  0  0  0999 V2000
    1.6647    1.2167   -0.0588 O   0  5  0  0  0  0  0  0  0  0  0  0
    2.2620   -0.9886   -0.0737 O   0  0  0  0  0  0  0  0  0  0  0  0
   -1.0834   -0.0428   -0.0052 N   0  3  0  0  0  0  0  0  0  0  0  0
    0.1619   -0.4053    0.7909 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.0382   -0.7338   -1.3605 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.3212   -0.4970    0.7548 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.1363    1.4649   -0.2061 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.4905   -0.0141    0.1585 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0791    0.0855    1.7688 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.1264   -1.4889    0.9618 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.9745   -1.8137   -1.1971 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.9562   -0.4850   -1.9018 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.1682   -0.3778   -1.9193 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.3458    0.0231    1.7170 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.2062   -0.2465    0.1624 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.2591   -1.5790    0.9049 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.9357    1.9597    0.7486 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.4275    1.7647   -0.9811 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.1438    1.7231   -0.5495 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  8  1  0  0  0  0
  2  8  2  0  0  0  0
  3  4  1  0  0  0  0
  3  5  1  0  0  0  0
  3  6  1  0  0  0  0
  3  7  1  0  0  0  0
  4  8  1  0  0  0  0
  4  9  1  0  0  0  0
  4 10  1  0  0  0  0
  5 11  1  0  0  0  0
  5 12  1  0  0  0  0
  5 13  1  0  0  0  0
  6 14  1  0  0  0  0
  6 15  1  0  0  0  0
  6 16  1  0  0  0  0
  7 17  1  0  0  0  0
  7 18  1  0  0  0  0
  7 19  1  0  0  0  0
M  CHG  2   1  -1   3   1
M  END
> <PUBCHEM_COMPOUND_CID>
247

> <PUBCHEM_IUPAC_NAME>
2-(trimethylazaniumyl)acetate

> <PUBCHEM_MOLECULAR_FORMULA>
C5H11NO2

$$$$
1234
  second record must be ignored

  1  0  0     0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
M  END
$$$$
`;

/** Pyridinium cation (MOL file): aromatic bond type 4 and the charge only in M  CHG. */
export const PYRIDINIUM_MOL = `Pyridinium
  MolStdio11222612003D
aromatic bonds written as type 4
 12 12  0  0  0  0  0  0  0  0999 V2000
    1.3900    0.0000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
    0.6950    1.2038    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.6950    1.2038    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.3900    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.6950   -1.2038    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.6950   -1.2038    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.4000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.2350    2.1391    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2350    2.1391    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.4700    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2350   -2.1391    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.2350   -2.1391    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  4  0  0  0  0
  2  3  4  0  0  0  0
  3  4  4  0  0  0  0
  4  5  4  0  0  0  0
  5  6  4  0  0  0  0
  6  1  4  0  0  0  0
  1  7  1  0  0  0  0
  2  8  1  0  0  0  0
  3  9  1  0  0  0  0
  4 10  1  0  0  0  0
  5 11  1  0  0  0  0
  6 12  1  0  0  0  0
M  CHG  1   1   1
M  END
`;

/** Acetate anion as a V3000 molfile with a continued (-) atom line and CHG= property. */
export const ACETATE_V3000 = `acetate
  MolStdio11222612003D

  0  0  0     0  0            999 V3000
M  V30 BEGIN CTAB
M  V30 COUNTS 7 6 0 0 0
M  V30 BEGIN ATOM
M  V30 1 C -0.9550 0.1895 0.0000 0
M  V30 2 C 0.5650 0.1895 0.0000 0
M  V30 3 O 1.2190 1.2560 0.0000 0
M  V30 4 O 1.1520 -0.9370 0.0000 0 -
M  V30 CHG=-1
M  V30 5 H -1.3189 1.2170 0.0000 0
M  V30 6 H -1.3189 -0.3242 -0.8898 0
M  V30 7 H -1.3189 -0.3242 0.8898 0
M  V30 END ATOM
M  V30 BEGIN BOND
M  V30 1 1 1 2
M  V30 2 2 2 3
M  V30 3 1 2 4
M  V30 4 1 1 5
M  V30 5 1 1 6
M  V30 6 1 1 7
M  V30 END BOND
M  V30 END CTAB
M  END
$$$$
`;

/** Acetamide as written by a docking-preparation tool: Gasteiger partial charges, amide bond type. */
export const ACETAMIDE_MOL2 = `# generated for testing
@<TRIPOS>MOLECULE
acetamide
    9     8     1     0     0
SMALL
GASTEIGER

@<TRIPOS>ATOM
      1 C1         -1.2730    0.0950    0.0000 C.3       1  UNL1       -0.0390
      2 C2          0.2250   -0.0360    0.0000 C.2       1  UNL1        0.2170
      3 O1          0.7790   -1.1340    0.0000 O.2       1  UNL1       -0.2740
      4 N1          0.9350    1.1060    0.0000 N.am      1  UNL1       -0.3700
      5 H1         -1.5870    1.1400    0.0000 H         1  UNL1        0.0310
      6 H2         -1.6800   -0.4170    0.8770 H         1  UNL1        0.0310
      7 H3         -1.6800   -0.4170   -0.8770 H         1  UNL1        0.0310
      8 H4          1.9440    1.0730    0.0000 H         1  UNL1        0.1590
      9 H5          0.4740    2.0050    0.0000 H         1  UNL1        0.1590
@<TRIPOS>BOND
     1     1     2    1
     2     2     3    2
     3     2     4   am
     4     1     5    1
     5     1     6    1
     6     1     7    1
     7     4     8    1
     8     4     9    1
@<TRIPOS>SUBSTRUCTURE
     1 UNL1        1 GROUP             0 ****  ****    0 ROOT
`;

/**
 * Ala-Gly dipeptide (zwitterion) with residues, chains in SUBSTRUCTURE, an N.4 ammonium (formal +1
 * inferred), an aromatic carboxylate, a lone pair (dropped), an 'nc' bond (dropped) and a second
 * molecule (ignored).
 */
export const DIPEPTIDE_MOL2 = `@<TRIPOS>MOLECULE
Ala-Gly
   14    14     2     0     0
PROTEIN
NO_CHARGES

@<TRIPOS>ATOM
      1 N           -1.9500    1.3700    0.0000 N.4       1  ALA1        0.0000
      2 CA          -0.5100    1.1500    0.0000 C.3       1  ALA1        0.0000
      3 C            0.0100   -0.2800    0.0000 C.2       1  ALA1        0.0000
      4 O           -0.7400   -1.2500    0.0000 O.2       1  ALA1        0.0000
      5 CB           0.0400    1.9100    1.2000 C.3       1  ALA1        0.0000
      6 H1          -2.3000    2.3300    0.0000 H         1  ALA1        0.0000
      7 H2          -2.3000    0.8900    0.8300 H         1  ALA1        0.0000
      8 H3          -2.3000    0.8900   -0.8300 H         1  ALA1        0.0000
      9 N            1.3300   -0.4100    0.0000 N.am      2  GLY2        0.0000
     10 CA           1.9600   -1.7200    0.0000 C.3       2  GLY2        0.0000
     11 C            3.4800   -1.6300    0.0000 C.2       2  GLY2        0.0000
     12 O            4.0400   -0.5100    0.0000 O.co2     2  GLY2        0.0000
     13 OXT          4.1200   -2.7100    0.0000 O.co2     2  GLY2        0.0000
     14 LP1         -1.0000   -1.6000    0.4000 LP        1  ALA1        0.0000
@<TRIPOS>BOND
     1     1     2    1
     2     2     3    1
     3     3     4    2
     4     2     5    1
     5     1     6    1
     6     1     7    1
     7     1     8    1
     8     3     9   am
     9     9    10    1
    10    10    11    1
    11    11    12   ar
    12    11    13   ar
    13     4    14    1
    14     5    13   nc
@<TRIPOS>SUBSTRUCTURE
     1 ALA1        1 RESIDUE           1 A     ALA     1 ROOT
     2 GLY2        9 RESIDUE           1 A     GLY     1
@<TRIPOS>MOLECULE
second
    1     0     0     0     0
SMALL
NO_CHARGES

@<TRIPOS>ATOM
      1 C1           0.0000    0.0000    0.0000 C.3       1  UNL1        0.0000
`;

/** Two-frame XYZ trajectory; the second H uses an atomic number and frame 1 has an extra column. */
export const WATER_XYZ = `3
water, energy=-76.4 Hartree
O     0.000000    0.000000    0.117300   0.10
1     0.000000    0.757200   -0.469200
H     0.000000   -0.757200   -0.469200
3
frame 2
O     9.000000    9.000000    9.117300
H     9.000000    9.757200    8.530800
H     9.000000    8.242800    8.530800
`;

/** Rock salt conventional cell as written by pymatgen / Materials Project (DDL1, P1, ionic type symbols). */
export const NACL_P1_CIF = `# generated using pymatgen
data_NaCl
_symmetry_space_group_name_H-M   'P 1'
_cell_length_a   5.64020000
_cell_length_b   5.64020000
_cell_length_c   5.64020000
_cell_angle_alpha   90.00000000
_cell_angle_beta   90.00000000
_cell_angle_gamma   90.00000000
_symmetry_Int_Tables_number   1
_chemical_formula_structural   NaCl
_chemical_formula_sum   'Na4 Cl4'
_cell_volume   179.42
_cell_formula_units_Z   4
loop_
 _symmetry_equiv_pos_site_id
 _symmetry_equiv_pos_as_xyz
  1  'x, y, z'
loop_
 _atom_site_type_symbol
 _atom_site_label
 _atom_site_symmetry_multiplicity
 _atom_site_fract_x
 _atom_site_fract_y
 _atom_site_fract_z
 _atom_site_occupancy
  Na+  Na0  1  0.00000000  0.00000000  0.00000000  1
  Na+  Na1  1  0.00000000  0.50000000  0.50000000  1
  Na+  Na2  1  0.50000000  0.00000000  0.50000000  1
  Na+  Na3  1  0.50000000  0.50000000  0.00000000  1
  Cl-  Cl4  1  0.50000000  0.00000000  0.00000000  1
  Cl-  Cl5  1  0.50000000  0.50000000  0.50000000  1
  Cl-  Cl6  1  0.00000000  0.00000000  0.50000000  1
  Cl-  Cl7  1  0.00000000  0.50000000  0.00000000  1
`;

/** Monoclinic P2(1)/c crystal (COD style): a two-atom asymmetric unit expanded by four operators. */
export const P21C_CIF = `data_test_p21c
_chemical_name_common             'test carbonyl'
_cell_length_a                    7.000(2)
_cell_length_b                    9.000(3)
_cell_length_c                    11.000(4)
_cell_angle_alpha                 90
_cell_angle_beta                  105.00(2)
_cell_angle_gamma                 90
_symmetry_space_group_name_H-M    'P 1 21/c 1'
_cod_database_code                9999999
loop_
_space_group_symop_id
_space_group_symop_operation_xyz
1 x,y,z
2 -x,y+1/2,-z+1/2
3 -x,-y,-z
4 x,-y+1/2,z+1/2
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_U_iso_or_equiv
C1 C 0.1000(3) 0.2000(2) 0.3000(2) 0.0250(5)
O1 O 0.2500(3) 0.2100(2) 0.3200(2) 0.0300(5)
loop_
_atom_site_aniso_label
_atom_site_aniso_U_11
_atom_site_aniso_U_22
C1 0.02 0.03
O1 0.03 0.03
`;
